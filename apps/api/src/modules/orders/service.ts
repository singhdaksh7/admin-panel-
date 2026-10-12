/**
 * ORDER SERVICE — stable contract for other modules (payments, returns, shipping webhooks).
 *
 *   type Actor = { type: "ADMIN" | "CUSTOMER" | "SYSTEM" | "WEBHOOK"; id?: string | null }
 *
 *   confirmOrder(ctx, orderId, actor): Promise<Order>
 *       PENDING -> CONFIRMED, commits reserved stock (onHand-=q, reserved-=q), writes event, sends
 *       'order.confirmation'. Idempotent: already CONFIRMED (or later) returns the order untouched.
 *       Throws 409 for CANCELLED/REFUNDED/RETURNED.
 *   confirmOrderInTx(ctx, tx, orderId, actor): same, inside a caller-owned transaction (no email).
 *   markPaymentStatus(ctx, { orderId, paymentId?, status, providerPaymentId? }, actor): Promise<Order>
 *       Updates the Payment (+ Order.paymentStatus). PAID never downgrades except to REFUNDED states.
 *       PAID on a PENDING order confirms it. Idempotent (webhook replays are no-ops).
 *   transitionOrder(ctx, orderId, toStatus, actor, note?): Promise<Order>
 *       Enforces TRANSITIONS under a row lock (SELECT ... FOR UPDATE). 409 on illegal transition.
 *       ->CONFIRMED commits stock, ->CANCELLED releases (never confirmed) or restocks (confirmed),
 *       ->RETURNED restocks once. Emits 'order.status' (non-blocking).
 *   cancelOrder(ctx, orderId, actor, reason?): Promise<Order>   (= transitionOrder to CANCELLED)
 *   expireUnpaidOrders(ctx, maxAgeMs = 60min): Promise<number>   scheduled job body.
 *
 * Stock lifecycle: checkout RESERVES; confirm COMMITS; cancel while PENDING RELEASES; cancel/return
 * after commit RESTOCKS. Coupon redemption is undone on cancellation.
 */
import type { Order, OrderItem, OrderStatus, PaymentStatus, Tx } from "@kash-commerce/database";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import { notify } from "../notifications/service";
import { releaseCouponRedemption } from "../coupons/service";
import { commitStock, releaseStock, restockItems } from "./stock";

export interface Actor {
  type: "ADMIN" | "CUSTOMER" | "SYSTEM" | "WEBHOOK";
  id?: string | null;
}

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURN_REQUESTED"],
  DELIVERED: ["RETURN_REQUESTED"],
  RETURN_REQUESTED: ["RETURNED", "DELIVERED"],
  RETURNED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

type OrderWithItems = Order & { items: OrderItem[] };

async function lockOrder(tx: Tx, orderId: string): Promise<OrderWithItems> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  if (!rows.length) throw AppError.notFound("Order");
  return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
}

const stockItems = (o: OrderWithItems) =>
  o.items
    .filter((i): i is OrderItem & { variantId: string } => !!i.variantId)
    .map((i) => ({ variantId: i.variantId, quantity: i.quantity }));

async function event(
  tx: Tx,
  orderId: string,
  e: {
    type: string;
    from?: OrderStatus | null;
    to?: OrderStatus | null;
    message?: string | null;
    actor: Actor;
    data?: object;
  },
) {
  await tx.orderEvent.create({
    data: {
      orderId,
      type: e.type,
      fromStatus: e.from ?? null,
      toStatus: e.to ?? null,
      message: e.message ?? null,
      actorType: e.actor.type,
      actorId: e.actor.id ?? null,
      data: e.data,
    },
  });
}

async function doConfirm(tx: Tx, o: OrderWithItems, actor: Actor): Promise<OrderWithItems> {
  await commitStock(tx, stockItems(o), {
    orderId: o.id,
    reason: `Order ${o.orderNumber} confirmed`,
    actorId: actor.id,
  });
  const updated = await tx.order.update({
    where: { id: o.id },
    data: { status: "CONFIRMED" },
    include: { items: true },
  });
  await event(tx, o.id, {
    type: "STATUS_CHANGED",
    from: o.status,
    to: "CONFIRMED",
    actor,
    message: "Order confirmed",
  });
  return updated;
}

async function doCancel(
  tx: Tx,
  o: OrderWithItems,
  actor: Actor,
  reason?: string,
): Promise<OrderWithItems> {
  const ref = { orderId: o.id, reason: `Order ${o.orderNumber} cancelled`, actorId: actor.id };
  if (o.status === "PENDING") await releaseStock(tx, stockItems(o), ref);
  else await restockItems(tx, stockItems(o), ref);
  await releaseCouponRedemption(tx, o.id);
  const updated = await tx.order.update({
    where: { id: o.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
    include: { items: true },
  });
  await event(tx, o.id, {
    type: "STATUS_CHANGED",
    from: o.status,
    to: "CANCELLED",
    actor,
    message: reason ?? "Order cancelled",
  });
  return updated;
}

function customerName(o: Order): string {
  const snap = (o.customerSnapshot ?? {}) as { name?: string };
  return snap.name ?? "";
}

export async function sendConfirmationEmail(ctx: AppContext, o: Order) {
  await notify(ctx, "order.confirmation", o.email, {
    name: customerName(o),
    orderNumber: o.orderNumber,
    total: o.total.toString(),
    currency: o.currency,
  });
}

async function sendStatusEmail(ctx: AppContext, o: Order) {
  await notify(ctx, "order.status", o.email, {
    name: customerName(o),
    orderNumber: o.orderNumber,
    status: o.status,
  });
}

export async function confirmOrderInTx(
  ctx: AppContext,
  tx: Tx,
  orderId: string,
  actor: Actor,
): Promise<Order> {
  void ctx;
  const o = await lockOrder(tx, orderId);
  if (o.status === "PENDING") return doConfirm(tx, o, actor);
  if (o.status === "CANCELLED" || o.status === "REFUNDED" || o.status === "RETURNED")
    throw AppError.conflict(`Order is ${o.status} and cannot be confirmed`);
  return o; // already confirmed or beyond: idempotent
}

export async function confirmOrder(ctx: AppContext, orderId: string, actor: Actor): Promise<Order> {
  const { order, changed } = await ctx.prisma.$transaction(async (tx) => {
    const before = await lockOrder(tx, orderId);
    const order = await confirmOrderInTx(ctx, tx, orderId, actor);
    return { order, changed: before.status === "PENDING" };
  });
  if (changed) await sendConfirmationEmail(ctx, order);
  return order;
}

export async function transitionOrder(
  ctx: AppContext,
  orderId: string,
  to: OrderStatus,
  actor: Actor,
  note?: string,
  opts: { onlyIfUnpaid?: boolean } = {},
): Promise<Order> {
  const result = await ctx.prisma.$transaction(
    async (tx) => {
      const o = await lockOrder(tx, orderId);
      if (
        opts.onlyIfUnpaid &&
        (o.status !== "PENDING" || o.paymentStatus === "PAID" || o.paymentStatus === "AUTHORIZED")
      )
        return { order: o, changed: false };
      if (!TRANSITIONS[o.status].includes(to))
        throw AppError.conflict(`Cannot change order status from ${o.status} to ${to}`, {
          from: o.status,
          to,
          allowed: TRANSITIONS[o.status],
        });
      if (to === "CONFIRMED")
        return { order: await doConfirm(tx, o, actor), changed: true, confirmed: true };
      if (to === "CANCELLED") return { order: await doCancel(tx, o, actor, note), changed: true };
      if (to === "RETURNED") {
        const already = await tx.inventoryMovement.count({
          where: { orderId: o.id, type: { in: ["RESTOCK", "RETURN"] } },
        });
        if (!already)
          await restockItems(tx, stockItems(o), {
            orderId: o.id,
            reason: `Order ${o.orderNumber} returned`,
            actorId: actor.id,
          });
      }
      const updated = await tx.order.update({
        where: { id: o.id },
        data: { status: to },
        include: { items: true },
      });
      await event(tx, o.id, {
        type: "STATUS_CHANGED",
        from: o.status,
        to,
        actor,
        message: note ?? null,
      });
      return { order: updated, changed: true };
    },
    { timeout: 15000 },
  );
  if (result.changed) {
    if ("confirmed" in result && result.confirmed) await sendConfirmationEmail(ctx, result.order);
    await sendStatusEmail(ctx, result.order);
  }
  return result.order;
}

export function cancelOrder(
  ctx: AppContext,
  orderId: string,
  actor: Actor,
  reason?: string,
): Promise<Order> {
  return transitionOrder(ctx, orderId, "CANCELLED", actor, reason);
}

export async function markPaymentStatus(
  ctx: AppContext,
  input: {
    orderId: string;
    paymentId?: string;
    status: PaymentStatus;
    providerPaymentId?: string | null;
  },
  actor: Actor,
): Promise<Order> {
  const result = await ctx.prisma.$transaction(
    async (tx) => {
      const o = await lockOrder(tx, input.orderId);
      const payment = input.paymentId
        ? await tx.payment.findFirst({ where: { id: input.paymentId, orderId: o.id } })
        : await tx.payment.findFirst({ where: { orderId: o.id }, orderBy: { createdAt: "desc" } });
      if (!payment) throw AppError.notFound("Payment");

      const cur = payment.status;
      const refundStates: PaymentStatus[] = ["REFUNDED", "PARTIALLY_REFUNDED"];
      const blocked =
        (cur === "PAID" && !refundStates.includes(input.status) && input.status !== "PAID") ||
        (cur === "REFUNDED" && input.status !== "REFUNDED");
      const noop =
        cur === input.status &&
        (!input.providerPaymentId || input.providerPaymentId === payment.providerPaymentId);
      if (blocked || noop) return { order: o, confirmed: false };

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: input.status,
          ...(input.providerPaymentId ? { providerPaymentId: input.providerPaymentId } : {}),
        },
      });
      let order: OrderWithItems = await tx.order.update({
        where: { id: o.id },
        data: { paymentStatus: input.status },
        include: { items: true },
      });
      await event(tx, o.id, {
        type: input.status === "PAID" ? "PAYMENT_PAID" : `PAYMENT_${input.status}`,
        actor,
        message: `Payment ${input.status}`,
        data: { paymentId: payment.id, provider: payment.provider },
      });
      let confirmed = false;
      if (input.status === "PAID") {
        if (order.status === "PENDING") {
          order = await doConfirm(tx, order, actor);
          confirmed = true;
        } else if (order.status === "CANCELLED") {
          await event(tx, o.id, {
            type: "PAYMENT_ON_CANCELLED_ORDER",
            actor,
            message: "Payment received for a cancelled order; refund required",
          });
        }
      }
      return { order, confirmed };
    },
    { timeout: 15000 },
  );
  if (result.confirmed) await sendConfirmationEmail(ctx, result.order);
  return result.order;
}

/** Scheduled job: cancel unpaid PENDING orders older than maxAgeMs, releasing their stock. */
export async function expireUnpaidOrders(
  ctx: AppContext,
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const stale = await ctx.prisma.order.findMany({
    where: {
      status: "PENDING",
      paymentStatus: { in: ["PENDING", "FAILED"] },
      createdAt: { lt: new Date(Date.now() - maxAgeMs) },
    },
    select: { id: true },
    take: 200,
  });
  let n = 0;
  for (const { id } of stale) {
    try {
      const o = await transitionOrder(
        ctx,
        id,
        "CANCELLED",
        { type: "SYSTEM" },
        "Payment not received in time",
        {
          onlyIfUnpaid: true,
        },
      );
      if (o.status === "CANCELLED") n++;
    } catch (err) {
      ctx.logger.error({ err, orderId: id }, "failed to expire order");
    }
  }
  return n;
}
