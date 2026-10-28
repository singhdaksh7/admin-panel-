import { Router } from "express";
import { z } from "zod";
import type { Payment, Prisma, Refund } from "@kash-commerce/database";
import type { WebhookEventResult } from "@kash-commerce/provider-sdk";
import { AppError, clampPage, fromMinor, paginated, toMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { sha256 } from "../../lib/crypto";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { requirePermission } from "../../middleware/adminAuth";
import { customerAuth } from "../../middleware/customerAuth";
import { markPaymentStatus, type Actor } from "../orders/service";
import { loadAccessibleOrder, safeProviderMessage } from "./access";
import { createRefund, finalizeRefund, settleRefund } from "./refunds";
import { notifyAdmin } from "../notifications/service";

const money = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Invalid amount"),
);

const verifyBody = z.object({
  orderNumber: z.string().trim().min(1).max(40),
  email: z.string().trim().email().max(254).optional(),
  providerOrderId: z.string().trim().min(1).max(200),
  providerPaymentId: z.string().trim().min(1).max(200),
  signature: z.string().trim().min(1).max(500),
});
const retryBody = z.object({
  orderNumber: z.string().trim().min(1).max(40),
  email: z.string().trim().email().max(254).optional(),
});
const markPaidBody = z.object({ note: z.string().trim().max(500).optional() });
const refundBody = z.object({
  amount: money,
  reason: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});
const settleBody = z.object({ status: z.enum(["PROCESSED", "FAILED"]) });
const PAY_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "PAID",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PAY_STATUSES).optional(),
  provider: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const refundDto = (r: Refund) => ({
  id: r.id,
  paymentId: r.paymentId,
  returnId: r.returnId,
  amount: r.amount.toFixed(2),
  reason: r.reason,
  providerRefundId: r.providerRefundId,
  status: r.status,
  createdAt: r.createdAt,
});

const paymentDto = (p: Payment & { refunds?: Refund[]; order?: { orderNumber: string } }) => ({
  id: p.id,
  orderId: p.orderId,
  ...(p.order ? { orderNumber: p.order.orderNumber } : {}),
  provider: p.provider,
  providerOrderId: p.providerOrderId,
  providerPaymentId: p.providerPaymentId,
  status: p.status,
  amount: p.amount.toFixed(2),
  currency: p.currency,
  refundedAmount: p.refundedAmount.toFixed(2),
  refundableAmount:
    p.status === "PAID" || p.status === "PARTIALLY_REFUNDED"
      ? fromMinor(Math.max(0, toMinor(p.amount.toFixed(2)) - toMinor(p.refundedAmount.toFixed(2))))
      : "0.00",
  createdAt: p.createdAt,
  ...(p.refunds ? { refunds: p.refunds.map(refundDto) } : {}),
});

function headerMap(h: Record<string, string | string[] | undefined>) {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const pub = Router();
  const admin = Router();
  const webhooks = Router();
  const opt = customerAuth(ctx, { required: false });

  // ───────── POST /payments/verify ─────────
  pub.post(
    "/payments/verify",
    limiters.checkout,
    opt,
    h(async (req, res) => {
      const b = parse(verifyBody, req.body);
      const order = await loadAccessibleOrder(p, req, b.orderNumber, b.email);
      const payment = await p.payment.findFirst({
        where: { orderId: order.id, providerOrderId: b.providerOrderId },
      });
      if (!payment) throw AppError.notFound("Payment");
      const impl = ctx.providers.payment[payment.provider];
      if (!impl) throw new AppError(502, "PROVIDER_ERROR", "Payment provider is unavailable");
      const actor: Actor = req.customer
        ? { type: "CUSTOMER", id: req.customer.id }
        : { type: "SYSTEM" };
      const respond = async (httpStatus = 200) => {
        const o = await p.order.findUniqueOrThrow({ where: { id: order.id } });
        const pay = await p.payment.findUniqueOrThrow({ where: { id: payment.id } });
        res.status(httpStatus).json({
          orderNumber: o.orderNumber,
          orderStatus: o.status,
          paymentStatus: pay.status,
          paid: pay.status === "PAID",
        });
      };

      // the amount we ask the provider to collect must be the order total (never client data)
      if (toMinor(payment.amount.toFixed(2)) !== toMinor(order.total.toFixed(2))) {
        ctx.logger.error(
          { orderId: order.id, paymentId: payment.id },
          "payment/order amount mismatch",
        );
        throw AppError.conflict("Payment amount does not match the order total");
      }

      let result;
      try {
        result = await impl.verifyPayment({
          providerOrderId: b.providerOrderId,
          providerPaymentId: b.providerPaymentId,
          signature: b.signature,
        });
      } catch (err) {
        throw new AppError(
          502,
          "PROVIDER_ERROR",
          safeProviderMessage(err, "Payment could not be verified, please retry"),
        );
      }
      if (result.verified && result.status === "PAID") {
        await markPaymentStatus(
          ctx,
          {
            orderId: order.id,
            paymentId: payment.id,
            status: "PAID",
            providerPaymentId: b.providerPaymentId,
          },
          actor,
        );
        await notifyAdmin(ctx, "payment_successful", {
          orderNumber: order.orderNumber,
          total: order.total.toString(),
          currency: order.currency,
        });
        return respond();
      }
      if (result.verified && result.status === "PENDING") return respond(202);
      // failed verification: only a still-PENDING payment is marked FAILED; a PAID one is never touched
      const cur = await p.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (cur.status === "PENDING") {
        await markPaymentStatus(
          ctx,
          { orderId: order.id, paymentId: payment.id, status: "FAILED" },
          actor,
        );
        await notifyAdmin(ctx, "payment_failed", {
          orderNumber: order.orderNumber,
          total: order.total.toString(),
          currency: order.currency,
          status: "Verification failed",
        });
      }
      throw new AppError(402, "PAYMENT_FAILED", "Payment verification failed");
    }),
  );

  // ───────── POST /payments/retry ─────────
  pub.post(
    "/payments/retry",
    limiters.checkout,
    opt,
    h(async (req, res) => {
      const b = parse(retryBody, req.body);
      const order = await loadAccessibleOrder(p, req, b.orderNumber, b.email);
      const provider = order.paymentProvider;
      if (
        order.status !== "PENDING" ||
        order.paymentStatus === "PAID" ||
        !provider ||
        provider === "MANUAL"
      )
        throw AppError.conflict("This order does not need an online payment");
      const impl = ctx.providers.payment[provider];
      if (!impl) throw new AppError(502, "PROVIDER_ERROR", "Payment provider is unavailable");
      const latest = await p.payment.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: "desc" },
      });
      if (latest && latest.status !== "FAILED" && latest.providerOrderId)
        throw AppError.conflict("A payment is already in progress for this order");
      if (latest && latest.status === "PAID") throw AppError.conflict("Order is already paid");

      const snap = (order.customerSnapshot ?? {}) as { name?: string; phone?: string | null };
      let created;
      try {
        created = await impl.createPayment({
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.total.toFixed(2),
          currency: order.currency,
          customer: { email: order.email, name: snap.name, phone: snap.phone ?? undefined },
        });
      } catch (err) {
        ctx.logger.error({ err, orderId: order.id }, "payment retry failed");
        throw new AppError(
          502,
          "PROVIDER_ERROR",
          "Payment could not be initiated. Please retry or contact support.",
        );
      }
      await p.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
        const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        if (fresh.status !== "PENDING" || fresh.paymentStatus === "PAID")
          throw AppError.conflict("Order can no longer be paid");
        const same = await tx.payment.findFirst({
          where: { provider, providerOrderId: created.providerOrderId },
        });
        const reusable = same ?? (latest && !latest.providerOrderId ? latest : null);
        if (reusable && reusable.orderId === order.id) {
          if (reusable.status === "PAID") throw AppError.conflict("Order is already paid");
          await tx.payment.update({
            where: { id: reusable.id },
            data: { status: "PENDING", providerOrderId: created.providerOrderId },
          });
        } else if (same) {
          throw AppError.conflict("Payment reference conflict");
        } else {
          await tx.payment.create({
            data: {
              orderId: order.id,
              provider,
              providerOrderId: created.providerOrderId,
              status: "PENDING",
              amount: order.total,
              currency: order.currency,
            },
          });
        }
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "PENDING" } });
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "PAYMENT_RETRY",
            message: "Payment re-initiated",
            actorType: req.customer ? "CUSTOMER" : "SYSTEM",
            actorId: req.customer?.id ?? null,
          },
        });
      });
      if (created.status === "PAID")
        await markPaymentStatus(ctx, { orderId: order.id, status: "PAID" }, { type: "SYSTEM" });
      res.json({
        orderNumber: order.orderNumber,
        paymentProvider: provider,
        clientPayload: created.clientPayload,
      });
    }),
  );

  // ───────── POST /webhooks/:provider ─────────
  webhooks.post(
    "/:provider",
    h(async (req, res, next) => {
      const key = String(req.params.provider).toUpperCase();
      const impl = ctx.providers.payment[key];
      if (!impl || key === "MANUAL") return void next();
      if (!req.rawBody) throw AppError.badRequest("Missing request body");
      // throws 401 on a bad signature, 400 on malformed payload
      const ev = await impl.handleWebhook(req.rawBody, headerMap(req.headers));

      // race-safe idempotency: the unique (provider, eventId) constraint is the only gate
      let row;
      try {
        row = await p.webhookEvent.create({
          data: {
            provider: key,
            eventId: ev.eventId,
            type: ev.type.slice(0, 100),
            payloadHash: sha256(req.rawBody.toString("utf8")),
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002")
          return void res.status(200).json({ received: true, duplicate: true });
        throw e;
      }
      let error: string | null = null;
      try {
        error = await processWebhook(key, ev);
      } catch (err) {
        // let the provider retry: release the idempotency claim, answer 500
        await p.webhookEvent.delete({ where: { id: row.id } }).catch(() => undefined);
        throw err;
      }
      await p.webhookEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date(), error },
      });
      if (error) ctx.logger.warn({ provider: key, eventId: ev.eventId, error }, "webhook rejected");
      res.status(200).json({ received: true, duplicate: false });
    }),
  );

  /** Returns an error string when the event was recorded but intentionally not applied. */
  async function processWebhook(key: string, ev: WebhookEventResult): Promise<string | null> {
    if (!ev.status) return null; // event type we do not act on
    const payment =
      (ev.providerOrderId
        ? await p.payment.findUnique({
            where: {
              provider_providerOrderId: { provider: key, providerOrderId: ev.providerOrderId },
            },
          })
        : null) ??
      (ev.providerPaymentId
        ? await p.payment.findFirst({
            where: { provider: key, providerPaymentId: ev.providerPaymentId },
          })
        : null);
    if (!payment) return "unknown payment";
    const actor: Actor = { type: "WEBHOOK" };

    if (ev.status === "PAID" || ev.status === "FAILED") {
      if (ev.amount !== undefined) {
        let evMinor: number;
        try {
          evMinor = toMinor(ev.amount);
        } catch {
          return "invalid amount in event";
        }
        if (evMinor !== toMinor(payment.amount.toFixed(2)))
          return `amount mismatch: event ${ev.amount} vs expected ${payment.amount.toFixed(2)}`;
      }
      if (ev.status === "PAID") {
        const order = await p.order.findUniqueOrThrow({ where: { id: payment.orderId } });
        if (toMinor(order.total.toFixed(2)) !== toMinor(payment.amount.toFixed(2)))
          return "payment amount does not match the order total";
        await markPaymentStatus(
          ctx,
          {
            orderId: payment.orderId,
            paymentId: payment.id,
            status: "PAID",
            providerPaymentId: ev.providerPaymentId,
          },
          actor,
        );
        await notifyAdmin(ctx, "payment_successful", {
          orderNumber: order.orderNumber,
          total: order.total.toString(),
          currency: order.currency,
        });
      } else if (payment.status === "PENDING") {
        const order = await p.order.findUnique({ where: { id: payment.orderId } });
        await markPaymentStatus(
          ctx,
          { orderId: payment.orderId, paymentId: payment.id, status: "FAILED" },
          actor,
        );
        if (order) {
          await notifyAdmin(ctx, "payment_failed", {
            orderNumber: order.orderNumber,
            total: order.total.toString(),
            currency: order.currency,
            status: "Webhook reported payment failure",
          });
        }
      }
      return null;
    }

    // REFUNDED: reconcile with a refund we initiated
    if (ev.amount === undefined) return "refund event without amount";
    const pending = await p.refund.findFirst({
      where: { paymentId: payment.id, status: "PENDING", amount: ev.amount },
      orderBy: { createdAt: "asc" },
    });
    if (!pending) return "no matching pending refund (initiated outside this system?)";
    await finalizeRefund(ctx, pending.id, actor);
    return null;
  }

  // ───────── admin: payments ─────────
  admin.get(
    "/payments",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const q = parse(listQuery, req.query);
      const where: Prisma.PaymentWhereInput = {
        ...(q.status ? { status: q.status } : {}),
        ...(q.provider ? { provider: q.provider.toUpperCase() } : {}),
        ...(q.from || q.to
          ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
          : {}),
        ...(q.q
          ? {
              OR: [
                { order: { orderNumber: { contains: q.q, mode: "insensitive" } } },
                { order: { email: { contains: q.q, mode: "insensitive" } } },
                { providerPaymentId: { contains: q.q } },
                { providerOrderId: { contains: q.q } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        p.payment.findMany({
          where,
          include: { order: { select: { orderNumber: true } } },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        p.payment.count({ where }),
      ]);
      res.json(paginated(rows.map(paymentDto), total, { page, pageSize }));
    }),
  );

  admin.get(
    "/orders/:id/payments",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const o = await p.order.findFirst({ where: { OR: [{ id }, { orderNumber: id }] } });
      if (!o) throw AppError.notFound("Order");
      const rows = await p.payment.findMany({
        where: { orderId: o.id },
        include: { refunds: { orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "asc" },
      });
      res.json({ items: rows.map(paymentDto) });
    }),
  );

  admin.post(
    "/orders/:id/payments/mark-paid",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(markPaidBody, req.body ?? {});
      const o = await p.order.findFirst({ where: { OR: [{ id }, { orderNumber: id }] } });
      if (!o) throw AppError.notFound("Order");
      if (o.status === "CANCELLED" || o.status === "REFUNDED" || o.status === "RETURNED")
        throw AppError.conflict(`A ${o.status} order cannot be marked paid`);
      const payments = await p.payment.findMany({ where: { orderId: o.id } });
      if (payments.some((x) => x.provider !== "MANUAL"))
        throw AppError.conflict(
          "Only manual (cash on delivery / bank transfer) payments can be marked paid",
        );
      let pay = payments.sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!pay) {
        try {
          pay = await p.payment.create({
            data: {
              orderId: o.id,
              provider: "MANUAL",
              providerOrderId: `manual_${o.orderNumber}`,
              status: "PENDING",
              amount: o.total,
              currency: o.currency,
            },
          });
        } catch (e) {
          if ((e as { code?: string }).code !== "P2002") throw e;
          pay = (await p.payment.findFirst({ where: { orderId: o.id, provider: "MANUAL" } }))!;
        }
      }
      const wasPaid = pay.status === "PAID";
      const order = await markPaymentStatus(
        ctx,
        { orderId: o.id, paymentId: pay.id, status: "PAID" },
        { type: "ADMIN", id: req.admin!.id },
      );
      if (!wasPaid) {
        await p.orderEvent.create({
          data: {
            orderId: o.id,
            type: "PAYMENT_MARKED_PAID",
            message: b.note ?? "Payment marked as received",
            actorType: "ADMIN",
            actorId: req.admin!.id,
            data: { paymentId: pay.id },
          },
        });
        await audit(ctx, req, {
          action: "payment.mark-paid",
          entityType: "Payment",
          entityId: pay.id,
          extra: { orderId: o.id, note: b.note },
        });
      }
      const fresh = await p.payment.findUniqueOrThrow({
        where: { id: pay.id },
        include: { refunds: true },
      });
      res.json({
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
        },
        payment: paymentDto(fresh),
      });
    }),
  );

  // ───────── admin: refunds ─────────
  admin.post(
    "/payments/:id/refund",
    requirePermission("returns.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(refundBody, req.body);
      const refund = await createRefund(
        ctx,
        {
          paymentId: id,
          amount: b.amount,
          reason: b.reason,
          clientKey: b.idempotencyKey ?? req.header("idempotency-key") ?? null,
        },
        { type: "ADMIN", id: req.admin!.id },
      );
      await audit(ctx, req, {
        action: "payment.refund",
        entityType: "Payment",
        entityId: id,
        extra: { refundId: refund.id, amount: refund.amount.toFixed(2), reason: b.reason },
      });
      const payment = await p.payment.findUniqueOrThrow({ where: { id } });
      res.status(201).json({ refund: refundDto(refund), payment: paymentDto(payment) });
    }),
  );

  admin.get(
    "/refunds",
    requirePermission("returns.read"),
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const status =
        typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
      const where: Prisma.RefundWhereInput = status ? { status } : {};
      const [rows, total] = await Promise.all([
        p.refund.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        p.refund.count({ where }),
      ]);
      res.json(paginated(rows.map(refundDto), total, { page, pageSize }));
    }),
  );

  admin.patch(
    "/refunds/:id",
    requirePermission("returns.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(settleBody, req.body);
      const refund = await settleRefund(ctx, id, b.status, { type: "ADMIN", id: req.admin!.id });
      await audit(ctx, req, {
        action: "refund.settle",
        entityType: "Refund",
        entityId: id,
        extra: { status: b.status },
      });
      res.json(refundDto(refund));
    }),
  );

  return { public: pub, admin, webhooks };
}
