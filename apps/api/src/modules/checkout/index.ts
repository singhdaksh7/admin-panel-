import crypto from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "@kash-commerce/database";
import { AppError, fromMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { sha256 } from "../../lib/crypto";
import { customerAuth } from "../../middleware/customerAuth";
import { createLimiters } from "../../lib/rateLimits";
import { cartTokenFrom, findCartBy } from "../cart";
import { redeemCoupon } from "../coupons/service";
import { publicOrderDto, publicOrderInclude } from "../orders/dto";
import { confirmOrderInTx, markPaymentStatus, sendConfirmationEmail } from "../orders/service";
import { reserveStock } from "../orders/stock";
import { computeTotals, totalsDto, type Totals } from "./totals";

const addressSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).nullish(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().max(100).nullish(),
  postalCode: z.string().trim().min(1).max(20),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase()),
});

const summaryBody = z.object({
  cartToken: z.string().min(10).max(128).optional(),
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  shippingMethodCode: z.string().trim().max(40).optional(),
  couponCode: z.string().trim().max(40).optional(),
});
const createBody = summaryBody.extend({
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(30).optional(),
  paymentProvider: z.string().trim().max(40).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

type Addr = z.infer<typeof addressSchema>;
const cleanAddr = (a: Addr) => ({
  fullName: a.fullName,
  phone: a.phone ?? null,
  line1: a.line1,
  line2: a.line2 ?? null,
  city: a.city,
  state: a.state ?? null,
  postalCode: a.postalCode,
  country: a.country,
});

/** Customer cart first; a signed-in shopper may also check out an explicit anonymous cart token. */
async function cartFor(
  db: Parameters<typeof findCartBy>[0],
  customerId: string | undefined,
  token: string | undefined,
) {
  return (
    (customerId ? await findCartBy(db, { customerId }) : null) ??
    (token ? await findCartBy(db, { token }) : null)
  );
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const router = Router();
  const opt = customerAuth(ctx, { required: false });

  function assertRules(t: Totals, req: Request, phone: string | null | undefined) {
    const s = t.settings;
    if (!s.guestCheckout && !req.customer)
      throw AppError.unauthenticated("Please sign in to check out");
    if (s.requirePhone && !phone) throw AppError.validation("A phone number is required");
    if (s.minOrderMinor > 0 && t.subtotalMinor - t.discountMinor < s.minOrderMinor)
      throw AppError.validation(`Minimum order amount is ${fromMinor(s.minOrderMinor)}`, {
        minOrderAmount: fromMinor(s.minOrderMinor),
      });
  }

  router.post(
    "/checkout/summary",
    limiters.checkout,
    opt,
    h(async (req, res) => {
      const b = parse(summaryBody, req.body);
      const cart = await cartFor(p, req.customer?.id, b.cartToken ?? cartTokenFrom(req));
      if (!cart || cart.items.length === 0) throw AppError.badRequest("Cart is empty");
      const ship = cleanAddr(b.shippingAddress);
      const t = await computeTotals(ctx, p, {
        items: cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        couponCode: b.couponCode ?? cart.couponCode,
        address: ship,
        shippingMethodCode: b.shippingMethodCode,
        includeShipping: true,
        strict: true,
        customerId: req.customer?.id,
        email: req.customer?.email,
      });
      assertRules(t, req, ship.phone);
      res.json(totalsDto(t));
    }),
  );

  async function nextOrderNumber(tx: Prisma.TransactionClient, prefix: string): Promise<string> {
    await tx.$executeRaw`INSERT INTO "OrderSequence" ("id", "value") VALUES ('order', 100000) ON CONFLICT ("id") DO NOTHING`;
    const rows = await tx.$queryRaw<
      { value: number }[]
    >`UPDATE "OrderSequence" SET "value" = "value" + 1 WHERE "id" = 'order' RETURNING "value"`;
    return `${prefix}-${rows[0]!.value}`;
  }

  router.post(
    "/checkout/create",
    limiters.checkout,
    opt,
    h(async (req, res) => {
      const b = parse(createBody, req.body);
      const rawKey = b.idempotencyKey ?? req.header("idempotency-key") ?? undefined;
      if (rawKey !== undefined && (rawKey.length < 8 || rawKey.length > 128))
        throw AppError.validation("Idempotency key must be 8-128 characters");
      const token = b.cartToken ?? cartTokenFrom(req);
      const email = (b.email ?? req.customer?.email)?.toLowerCase();
      if (!email) throw AppError.validation("Email is required");
      if (!z.string().email().safeParse(email).success)
        throw AppError.validation("Email is invalid");

      // ── idempotency ──
      const idemKey = rawKey ? `checkout:${rawKey}` : null;
      const requestHash = sha256(
        JSON.stringify({
          who: req.customer?.id ?? token ?? null,
          email,
          ship: b.shippingAddress,
          bill: b.billingAddress ?? null,
          m: b.shippingMethodCode ?? null,
          c: b.couponCode ?? null,
          pp: b.paymentProvider ?? null,
          ph: b.phone ?? null,
        }),
      );
      if (idemKey) {
        let row = await p.idempotencyKey.findUnique({ where: { key: idemKey } });
        if (!row) {
          try {
            await p.idempotencyKey.create({
              data: { key: idemKey, scope: "checkout", requestHash },
            });
          } catch (e) {
            if ((e as { code?: string }).code !== "P2002") throw e;
            row = await p.idempotencyKey.findUnique({ where: { key: idemKey } });
          }
        }
        if (row) {
          if (row.requestHash !== requestHash)
            throw AppError.conflict("Idempotency key was already used with a different request");
          for (let i = 0; i < 25 && !row?.response; i++) {
            await new Promise((r) => setTimeout(r, 200));
            row = await p.idempotencyKey.findUnique({ where: { key: idemKey } });
            if (!row) break;
          }
          if (!row?.response)
            throw AppError.conflict("A request with this idempotency key is in progress");
          return void res.status(200).json({ ...(row.response as object), idempotentReplay: true });
        }
      }

      try {
        const ship = cleanAddr(b.shippingAddress);
        const bill = b.billingAddress ? cleanAddr(b.billingAddress) : ship;
        const phone = b.phone ?? ship.phone;

        const created = await p.$transaction(
          async (tx) => {
            const cart = await cartFor(tx, req.customer?.id, token);
            if (!cart || cart.items.length === 0) throw AppError.badRequest("Cart is empty");
            const t = await computeTotals(ctx, tx, {
              items: cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
              couponCode: b.couponCode ?? cart.couponCode,
              address: ship,
              shippingMethodCode: b.shippingMethodCode,
              includeShipping: true,
              strict: true,
              customerId: req.customer?.id,
              email,
            });
            assertRules(t, req, phone);

            // payment provider selection
            const active = ctx.providers.activePayment;
            let provider: string | null = b.paymentProvider?.toUpperCase() ?? active;
            if (provider !== active && provider !== "MANUAL")
              throw AppError.validation("Unsupported payment provider");
            if (provider === "MANUAL") {
              const off = await tx.integrationSetting.findFirst({
                where: { kind: "PAYMENT", provider: "MANUAL", enabled: false },
              });
              if (off) throw AppError.validation("Cash on delivery is not available");
            }
            const free = t.totalMinor === 0;
            if (free) provider = null;

            const orderId = crypto.randomUUID();
            await reserveStock(
              tx,
              t.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
              { orderId, reason: "Reserved at checkout" },
            );
            if (t.coupon)
              await redeemCoupon(tx, {
                couponId: t.coupon.coupon.id,
                orderId,
                customerId: req.customer?.id,
                email,
                amountMinor: t.discountMinor,
              });
            const orderNumber = await nextOrderNumber(tx, t.settings.orderPrefix);

            const order = await tx.order.create({
              data: {
                id: orderId,
                orderNumber,
                status: "PENDING",
                paymentStatus: "PENDING",
                customerId: req.customer?.id ?? null,
                customerSnapshot: { email, name: ship.fullName, phone: phone ?? null },
                email,
                currency: t.currency,
                subtotal: fromMinor(t.subtotalMinor),
                discountTotal: fromMinor(t.discountMinor),
                shippingTotal: fromMinor(t.shippingMinor),
                taxTotal: fromMinor(t.taxMinor),
                total: fromMinor(t.totalMinor),
                taxBreakdown: {
                  mode: t.settings.tax.mode ?? "NONE",
                  inclusive: t.taxInclusive,
                  lines: t.taxBreakdown.map((x) => ({
                    name: x.name,
                    rate: x.rate,
                    amount: fromMinor(x.amountMinor),
                  })),
                },
                couponCode: t.coupon?.coupon.code ?? null,
                shippingMethodCode: t.shippingMethod?.code ?? null,
                shippingMethodName: t.shippingMethod?.name ?? null,
                shippingAddress: ship,
                billingAddress: bill,
                paymentProvider: provider,
                idempotencyKey: idemKey,
                items: {
                  create: t.lines.map((l) => ({
                    variantId: l.variantId,
                    productId: l.productId,
                    productTitle: l.productTitle,
                    variantTitle: l.variantTitle,
                    sku: l.sku,
                    imageUrl: l.imageUrl,
                    attributes: l.attributes,
                    unitPrice: fromMinor(l.unitPriceMinor),
                    quantity: l.quantity,
                    discount: fromMinor(l.discountMinor),
                    taxRate: l.tax.taxRate,
                    taxAmount: fromMinor(l.tax.taxMinor),
                    lineTotal: fromMinor(l.tax.totalMinor),
                    hsnCode: l.hsnCode,
                  })),
                },
                events: {
                  create: {
                    type: "ORDER_PLACED",
                    toStatus: "PENDING",
                    actorType: req.customer ? "CUSTOMER" : "SYSTEM",
                    actorId: req.customer?.id ?? null,
                    message: "Order placed",
                  },
                },
              },
            });

            let paymentId: string | null = null;
            if (provider) {
              const pay = await tx.payment.create({
                data: {
                  orderId: order.id,
                  provider,
                  status: "PENDING",
                  amount: fromMinor(t.totalMinor),
                  currency: t.currency,
                },
              });
              paymentId = pay.id;
            }
            let confirmed = false;
            if (provider === "MANUAL" || free) {
              if (free)
                await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "PAID" } });
              await confirmOrderInTx(ctx, tx, order.id, { type: "SYSTEM" });
              confirmed = true;
            }

            await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
            await tx.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
            return { orderId: order.id, paymentId, provider, confirmed, total: t.totalMinor };
          },
          { timeout: 20_000, maxWait: 15_000 },
        );

        // ── payment initiation (outside the DB transaction: external I/O) ──
        let clientPayload: Record<string, unknown> | null = null;
        let paymentError: string | null = null;
        const order = await p.order.findUniqueOrThrow({ where: { id: created.orderId } });
        if (created.confirmed) await sendConfirmationEmail(ctx, order);
        const needsOnline = !!created.provider && created.provider !== "MANUAL";
        if (needsOnline) {
          const impl = ctx.providers.payment[created.provider!];
          if (impl) {
            try {
              const r = await impl.createPayment({
                orderId: order.id,
                orderNumber: order.orderNumber,
                amount: order.total.toFixed(2),
                currency: order.currency,
                customer: { email, name: ship.fullName, phone: phone ?? undefined },
              });
              await p.payment.update({
                where: { id: created.paymentId! },
                data: { providerOrderId: r.providerOrderId },
              });
              clientPayload = r.clientPayload;
              if (r.status === "PAID")
                await markPaymentStatus(
                  ctx,
                  { orderId: order.id, paymentId: created.paymentId!, status: "PAID" },
                  { type: "SYSTEM" },
                );
            } catch (err) {
              ctx.logger.error({ err, orderId: order.id }, "payment initiation failed");
              paymentError = "Payment could not be initiated. Please retry or contact support.";
            }
          }
        }
        const full = await p.order.findUniqueOrThrow({
          where: { id: created.orderId },
          include: publicOrderInclude,
        });
        const payload = {
          order: publicOrderDto(full),
          paymentRequired: needsOnline,
          paymentProvider: created.provider,
          providerAvailable: needsOnline ? !!ctx.providers.payment[created.provider!] : false,
          clientPayload,
          ...(paymentError ? { paymentError } : {}),
        };
        if (idemKey)
          await p.idempotencyKey.update({
            where: { key: idemKey },
            data: { response: payload as unknown as Prisma.InputJsonValue, statusCode: 201 },
          });
        res.status(201).json(payload);
      } catch (err) {
        if (idemKey)
          await p.idempotencyKey.deleteMany({ where: { key: idemKey } }).catch(() => undefined);
        throw err;
      }
    }),
  );

  return { public: router };
}
