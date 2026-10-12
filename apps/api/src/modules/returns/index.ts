import { Router, type Request } from "express";
import { z } from "zod";
import type {
  Order,
  OrderItem,
  Prisma,
  ReturnHistory,
  ReturnItem,
  ReturnRequest,
} from "@kash-commerce/database";
import { AppError, clampPage, fromMinor, paginated, toMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { requirePermission } from "../../middleware/adminAuth";
import { customerAuth } from "../../middleware/customerAuth";
import { transitionOrder, type Actor } from "../orders/service";
import { canAccessOrder } from "../payments/access";
import { createRefund } from "../payments/refunds";
import { restockItems } from "../inventory/service";
import {
  OPEN_RETURN_STATUSES,
  lockRow,
  notifyReturn,
  proportionalRefundMinor,
  settleOrderAfterReturnChange,
} from "./service";

const RETURN_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "RECEIVED",
  "REFUNDED",
  "CLOSED",
] as const;

const createBody = z.object({
  orderNumber: z.string().trim().min(1).max(40),
  email: z.string().trim().email().max(254).optional(),
  reason: z.string().trim().min(1).max(200),
  details: z.string().trim().max(2000).optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().trim().min(1).max(64),
        quantity: z.number().int().min(1).max(10000),
      }),
    )
    .min(1)
    .max(100),
});
const noteBody = z.object({ note: z.string().trim().max(1000).optional() });
const receiveBody = z.object({
  items: z
    .array(z.object({ returnItemId: z.string().trim().min(1).max(64), restock: z.boolean() }))
    .max(100)
    .default([]),
  note: z.string().trim().max(1000).optional(),
});
const refundBody = z.object({
  amount: z
    .preprocess(
      (v) => (typeof v === "number" ? String(v) : v),
      z
        .string()
        .trim()
        .regex(/^\d+(\.\d{1,2})?$/, "Invalid amount"),
    )
    .optional(),
  reason: z.string().trim().max(500).optional(),
});
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(RETURN_STATUSES).optional(),
});

type FullReturn = ReturnRequest & {
  items: (ReturnItem & { orderItem: OrderItem })[];
  history: ReturnHistory[];
  order: Pick<Order, "orderNumber" | "email" | "currency" | "id" | "customerId">;
};
const baseInclude = {
  items: { orderBy: { id: "asc" } },
  history: { orderBy: { createdAt: "asc" } },
  order: {
    select: { id: true, orderNumber: true, email: true, currency: true, customerId: true },
  },
} satisfies Prisma.ReturnRequestInclude;
type Base = Prisma.ReturnRequestGetPayload<{ include: typeof baseInclude }>;

function publicDto(r: FullReturn) {
  return {
    id: r.id,
    orderNumber: r.order.orderNumber,
    status: r.status,
    reason: r.reason,
    details: r.details,
    refundAmount: r.refundAmount?.toFixed(2) ?? null,
    decisionNote: r.decisionNote,
    currency: r.order.currency,
    createdAt: r.createdAt,
    items: r.items.map((i) => ({
      orderItemId: i.orderItemId,
      title: i.orderItem.productTitle,
      variantTitle: i.orderItem.variantTitle,
      sku: i.orderItem.sku,
      quantity: i.quantity,
    })),
    history: r.history.map((x) => ({ status: x.status, note: x.note, at: x.createdAt })),
  };
}

function adminDto(r: FullReturn) {
  return {
    ...publicDto(r),
    orderId: r.orderId,
    email: r.order.email,
    decidedById: r.decidedById,
    items: r.items.map((i) => ({
      id: i.id,
      orderItemId: i.orderItemId,
      title: i.orderItem.productTitle,
      variantTitle: i.orderItem.variantTitle,
      sku: i.orderItem.sku,
      quantity: i.quantity,
      restock: i.restock,
      lineTotal: i.orderItem.lineTotal.toFixed(2),
      orderedQuantity: i.orderItem.quantity,
    })),
    history: r.history.map((x) => ({
      status: x.status,
      note: x.note,
      actorId: x.actorId,
      at: x.createdAt,
    })),
  };
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const pub = Router();
  const admin = Router();
  const opt = customerAuth(ctx, { required: false });
  const authed = customerAuth(ctx, { required: true });

  /** ReturnItem has no relation to OrderItem in the schema: attach the order lines here. */
  async function hydrate(rows: Base[]): Promise<FullReturn[]> {
    const ids = [...new Set(rows.flatMap((r) => r.items.map((i) => i.orderItemId)))];
    const lines = await p.orderItem.findMany({ where: { id: { in: ids } } });
    const byId = new Map(lines.map((l) => [l.id, l]));
    return rows.map((r) => ({
      ...r,
      items: r.items.map((i) => ({ ...i, orderItem: byId.get(i.orderItemId)! })),
    }));
  }
  async function loadFull(id: string): Promise<FullReturn | null> {
    const r = await p.returnRequest.findUnique({ where: { id }, include: baseInclude });
    return r ? (await hydrate([r]))[0]! : null;
  }
  const loadFullOrThrow = async (id: string) => {
    const r = await loadFull(id);
    if (!r) throw AppError.notFound("Return");
    return r;
  };

  async function returnWindowDays(): Promise<number> {
    const s = await p.storeSettings.findUnique({ where: { id: "store" } });
    const v = ((s?.checkout ?? {}) as { returnWindowDays?: unknown }).returnWindowDays;
    return typeof v === "number" && v >= 0 ? v : 14;
  }

  /** Makes sure the order is in RETURN_REQUESTED after a return was created (race tolerant). */
  async function ensureReturnRequested(order: Order, actor: Actor) {
    if (order.status === "RETURN_REQUESTED") return;
    try {
      await transitionOrder(ctx, order.id, "RETURN_REQUESTED", actor, "Return requested");
    } catch (err) {
      const now = await p.order.findUnique({ where: { id: order.id }, select: { status: true } });
      if (now?.status !== "RETURN_REQUESTED") throw err;
    }
  }

  // ───────── customer / guest ─────────
  pub.post(
    "/returns",
    limiters.checkout,
    opt,
    h(async (req: Request, res) => {
      const b = parse(createBody, req.body);
      const found = await p.order.findUnique({
        where: { orderNumber: b.orderNumber.slice(0, 40) },
      });
      if (!canAccessOrder(req, found, b.email)) throw AppError.notFound("Order");
      const order = found!;
      const days = await returnWindowDays();
      const actor: Actor = req.customer
        ? { type: "CUSTOMER", id: req.customer.id }
        : { type: "SYSTEM" };

      const ids = b.items.map((i) => i.orderItemId);
      if (new Set(ids).size !== ids.length)
        throw AppError.validation("Each order item may appear only once");

      const created = await p.$transaction(
        async (tx) => {
          await lockRow(tx, "Order", order.id);
          const o = await tx.order.findUniqueOrThrow({
            where: { id: order.id },
            include: { items: true },
          });
          if (o.status !== "DELIVERED" && o.status !== "RETURN_REQUESTED")
            throw AppError.conflict("Returns can only be requested for delivered orders");
          const since = await tx.orderEvent.findFirst({
            where: { orderId: o.id, toStatus: "DELIVERED" },
            orderBy: { createdAt: "desc" },
          });
          const start = (since?.createdAt ?? o.placedAt).getTime();
          if (Date.now() - start > days * 86_400_000)
            throw AppError.conflict(`The ${days}-day return window has closed`);

          const open = await tx.returnItem.groupBy({
            by: ["orderItemId"],
            where: { return: { orderId: o.id, status: { in: OPEN_RETURN_STATUSES } } },
            _sum: { quantity: true },
          });
          const openQty = new Map(open.map((x) => [x.orderItemId, x._sum.quantity ?? 0]));
          for (const it of b.items) {
            const oi = o.items.find((x) => x.id === it.orderItemId);
            if (!oi) throw AppError.validation("Item does not belong to this order");
            const available = oi.quantity - oi.returnedQty - (openQty.get(oi.id) ?? 0);
            if (it.quantity > available)
              throw AppError.validation(
                `Only ${Math.max(0, available)} of "${oi.productTitle}" can still be returned`,
                { orderItemId: oi.id, available: Math.max(0, available) },
              );
          }
          const ret = await tx.returnRequest.create({
            data: {
              orderId: o.id,
              reason: b.reason,
              details: b.details ?? null,
              items: {
                create: b.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
              },
              history: { create: { status: "REQUESTED", note: b.details ?? null } },
            },
          });
          return { id: ret.id, status: o.status };
        },
        { timeout: 15000 },
      );
      await ensureReturnRequested({ ...order, status: created.status }, actor);
      await p.orderEvent.create({
        data: {
          orderId: order.id,
          type: "RETURN_REQUESTED",
          message: b.reason.slice(0, 200),
          actorType: actor.type,
          actorId: actor.id ?? null,
          data: { returnId: created.id },
        },
      });
      await notifyReturn(ctx, order.id, "REQUESTED");
      const full = await loadFullOrThrow(created.id);
      res.status(201).json(publicDto(full));
    }),
  );

  pub.get(
    "/returns/:id",
    limiters.checkout,
    opt,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const email = typeof req.query.email === "string" ? req.query.email : undefined;
      const r = await loadFull(id);
      if (!r || !canAccessOrder(req, r.order, email)) throw AppError.notFound("Return");
      res.json(publicDto(r));
    }),
  );

  pub.get(
    "/account/returns",
    authed,
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const where: Prisma.ReturnRequestWhereInput = { order: { customerId: req.customer!.id } };
      const [rows, total] = await Promise.all([
        p.returnRequest.findMany({
          where,
          include: baseInclude,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        p.returnRequest.count({ where }),
      ]);
      res.json(paginated((await hydrate(rows)).map(publicDto), total, { page, pageSize }));
    }),
  );

  // ───────── admin ─────────
  admin.get(
    "/returns",
    requirePermission("returns.read"),
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const q = parse(listQuery, req.query);
      const where: Prisma.ReturnRequestWhereInput = {
        ...(q.status ? { status: q.status } : {}),
        ...(q.q
          ? {
              OR: [
                { order: { orderNumber: { contains: q.q, mode: "insensitive" } } },
                { order: { email: { contains: q.q, mode: "insensitive" } } },
                { reason: { contains: q.q, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        p.returnRequest.findMany({
          where,
          include: baseInclude,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        p.returnRequest.count({ where }),
      ]);
      res.json(paginated((await hydrate(rows)).map(adminDto), total, { page, pageSize }));
    }),
  );

  admin.get(
    "/returns/:id",
    requirePermission("returns.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json(adminDto(await loadFullOrThrow(id)));
    }),
  );

  async function decide(
    req: Request,
    id: string,
    to: "APPROVED" | "REJECTED",
    note: string | undefined,
  ) {
    const adminId = req.admin!.id;
    const orderId = await p.$transaction(async (tx) => {
      await lockRow(tx, "ReturnRequest", id);
      const r = await tx.returnRequest.findUniqueOrThrow({ where: { id } });
      if (r.status !== "REQUESTED")
        throw AppError.conflict(`Return is ${r.status}; only REQUESTED returns can be decided`);
      await tx.returnRequest.update({
        where: { id },
        data: { status: to, decidedById: adminId, decisionNote: note ?? null },
      });
      await tx.returnHistory.create({
        data: { returnId: id, status: to, note: note ?? null, actorId: adminId },
      });
      return r.orderId;
    });
    const actor: Actor = { type: "ADMIN", id: adminId };
    if (to === "REJECTED") await settleOrderAfterReturnChange(ctx, orderId, actor);
    await notifyReturn(ctx, orderId, to);
    await audit(ctx, req, {
      action: to === "APPROVED" ? "return.approve" : "return.reject",
      entityType: "ReturnRequest",
      entityId: id,
      extra: { note },
    });
    return loadFullOrThrow(id);
  }

  admin.post(
    "/returns/:id/approve",
    requirePermission("returns.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(noteBody, req.body ?? {});
      res.json(adminDto(await decide(req, id, "APPROVED", b.note)));
    }),
  );
  admin.post(
    "/returns/:id/reject",
    requirePermission("returns.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(noteBody, req.body ?? {});
      res.json(adminDto(await decide(req, id, "REJECTED", b.note)));
    }),
  );

  admin.post(
    "/returns/:id/receive",
    requirePermission("returns.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(receiveBody, req.body ?? {});
      const adminId = req.admin!.id;
      const actor: Actor = { type: "ADMIN", id: adminId };
      const orderId = await p.$transaction(
        async (tx) => {
          await lockRow(tx, "ReturnRequest", id);
          const r = await tx.returnRequest.findUniqueOrThrow({
            where: { id },
            include: { items: true },
          });
          const lines = await tx.orderItem.findMany({
            where: { id: { in: r.items.map((i) => i.orderItemId) } },
          });
          const lineOf = (oid: string) => lines.find((l) => l.id === oid);
          if (r.status !== "APPROVED")
            throw AppError.conflict(`Return is ${r.status}; only APPROVED returns can be received`);
          const flags = new Map(b.items.map((x) => [x.returnItemId, x.restock]));
          for (const k of flags.keys())
            if (!r.items.some((i) => i.id === k))
              throw AppError.validation("Unknown return item", { returnItemId: k });
          const toRestock: { variantId: string; quantity: number }[] = [];
          for (const it of r.items) {
            const restock = flags.get(it.id) ?? false;
            await tx.returnItem.update({ where: { id: it.id }, data: { restock } });
            const variantId = lineOf(it.orderItemId)?.variantId;
            if (restock && variantId) toRestock.push({ variantId, quantity: it.quantity });
          }
          if (toRestock.length)
            await restockItems(tx, toRestock, {
              orderId: r.orderId,
              actorId: adminId,
              reason: "RETURN",
            });
          await tx.returnRequest.update({ where: { id }, data: { status: "RECEIVED" } });
          await tx.returnHistory.create({
            data: { returnId: id, status: "RECEIVED", note: b.note ?? null, actorId: adminId },
          });
          return r.orderId;
        },
        { timeout: 15000 },
      );
      await settleOrderAfterReturnChange(ctx, orderId, actor);
      await notifyReturn(ctx, orderId, "RECEIVED");
      await audit(ctx, req, {
        action: "return.receive",
        entityType: "ReturnRequest",
        entityId: id,
        extra: { items: b.items },
      });
      res.json(adminDto(await loadFullOrThrow(id)));
    }),
  );

  admin.post(
    "/returns/:id/refund",
    requirePermission("returns.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(refundBody, req.body ?? {});
      const ret = await loadFullOrThrow(id);
      if (ret.status !== "RECEIVED")
        throw AppError.conflict(`Return is ${ret.status}; only RECEIVED returns can be refunded`);
      if (
        await p.refund.count({
          where: { returnId: id, status: { in: ["PENDING", "PROCESSED"] } },
        })
      )
        throw AppError.conflict("This return already has a refund");
      const payment = await p.payment.findFirst({
        where: { orderId: ret.orderId, status: { in: ["PAID", "PARTIALLY_REFUNDED"] } },
        orderBy: { createdAt: "desc" },
      });
      if (!payment) throw AppError.conflict("This order has no paid payment to refund");
      const refundable =
        toMinor(payment.amount.toFixed(2)) - toMinor(payment.refundedAmount.toFixed(2));
      const proportional = proportionalRefundMinor(
        ret.items.map((i) => ({
          quantity: i.quantity,
          orderQuantity: i.orderItem.quantity,
          lineTotal: i.orderItem.lineTotal.toFixed(2),
        })),
      );
      let amountMinor: number;
      if (b.amount !== undefined) {
        amountMinor = toMinor(b.amount);
        if (amountMinor > refundable)
          throw AppError.validation("Refund exceeds the refundable balance", {
            refundable: fromMinor(Math.max(0, refundable)),
          });
      } else amountMinor = Math.min(proportional, refundable);
      if (amountMinor <= 0) throw AppError.validation("Nothing left to refund");

      const refund = await createRefund(
        ctx,
        {
          paymentId: payment.id,
          amount: fromMinor(amountMinor),
          reason: b.reason ?? `Return ${ret.id}`,
          returnId: ret.id,
        },
        { type: "ADMIN", id: req.admin!.id },
      );
      await audit(ctx, req, {
        action: "return.refund",
        entityType: "ReturnRequest",
        entityId: id,
        extra: { refundId: refund.id, amount: refund.amount.toFixed(2) },
      });
      const full = await loadFullOrThrow(id);
      res.status(201).json({
        return: adminDto(full),
        refund: {
          id: refund.id,
          amount: refund.amount.toFixed(2),
          status: refund.status,
          providerRefundId: refund.providerRefundId,
        },
      });
    }),
  );

  return { public: pub, admin };
}
