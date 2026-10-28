/**
 * RETURNS SERVICE
 *
 *   settleOrderAfterReturnChange(ctx, orderId, actor)
 *       Moves the order based on its returns: RETURN_REQUESTED -> RETURNED once no return is awaiting receipt
 *       (and at least one was received), or back to DELIVERED if every return was rejected/closed;
 *       RETURNED -> REFUNDED once every item is returned+refunded (or the payment is fully refunded).
 *       Always uses transitionOrder(..., { restock: false }): this module restocks per item itself.
 *   finalizeReturnRefund(ctx, returnId, actor)
 *       RECEIVED -> REFUNDED (guarded, once): sums processed refunds, bumps OrderItem.returnedQty, history,
 *       settles the order and notifies the customer.
 */
import type { ReturnStatus, Tx } from "@kash-commerce/database";
import { AppError, toMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import { transitionOrder, type Actor } from "../orders/service";
import { notify, notifyAdmin } from "../notifications/service";
import { customerNameOf } from "../payments/access";

export const OPEN_RETURN_STATUSES: ReturnStatus[] = ["REQUESTED", "APPROVED", "RECEIVED"];

export async function lockRow(tx: Tx, table: "Order" | "ReturnRequest", id: string) {
  const rows =
    table === "Order"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`
      : await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "ReturnRequest" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows.length) throw AppError.notFound(table === "Order" ? "Order" : "Return");
}

export async function notifyReturn(ctx: AppContext, orderId: string, status: ReturnStatus) {
  const o = await ctx.prisma.order.findUnique({ where: { id: orderId } });
  if (!o) return;
  await notify(ctx, "return.update", o.email, {
    name: customerNameOf(o),
    orderNumber: o.orderNumber,
    status,
  });
  if (status === "REQUESTED") {
    await notifyAdmin(ctx, "return_requested", {
      orderNumber: o.orderNumber,
      customerName: customerNameOf(o),
      customerEmail: o.email,
    });
  }
}

export async function settleOrderAfterReturnChange(
  ctx: AppContext,
  orderId: string,
  actor: Actor,
): Promise<void> {
  const p = ctx.prisma;
  const order = await p.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  const returns = await p.returnRequest.findMany({
    where: { orderId },
    select: { status: true },
  });
  const awaiting = returns.filter((r) => r.status === "REQUESTED" || r.status === "APPROVED");
  const received = returns.filter((r) => r.status === "RECEIVED" || r.status === "REFUNDED");
  try {
    if (order.status === "RETURN_REQUESTED" && awaiting.length === 0) {
      if (received.length > 0)
        await transitionOrder(ctx, orderId, "RETURNED", actor, "Return received", {
          restock: false,
        });
      else await transitionOrder(ctx, orderId, "DELIVERED", actor, "Return request closed");
    }
    const fresh = await p.order.findUniqueOrThrow({ where: { id: orderId } });
    if (fresh.status === "RETURNED") {
      const items = await p.orderItem.findMany({ where: { orderId } });
      const allBack = items.every((i) => i.returnedQty >= i.quantity);
      if (allBack || fresh.paymentStatus === "REFUNDED")
        await transitionOrder(ctx, orderId, "REFUNDED", actor, "Order fully refunded");
    }
  } catch (err) {
    if (err instanceof AppError && err.status === 409) {
      ctx.logger.warn({ orderId }, "order status could not be settled after return change");
      return;
    }
    throw err;
  }
}

export async function finalizeReturnRefund(
  ctx: AppContext,
  returnId: string,
  actor: Actor,
): Promise<void> {
  const orderId = await ctx.prisma.$transaction(async (tx) => {
    await lockRow(tx, "ReturnRequest", returnId);
    const ret = await tx.returnRequest.findUniqueOrThrow({
      where: { id: returnId },
      include: { items: true },
    });
    if (ret.status !== "RECEIVED") return null;
    const sum = await tx.refund.aggregate({
      where: { returnId, status: "PROCESSED" },
      _sum: { amount: true },
    });
    await tx.returnRequest.update({
      where: { id: returnId },
      data: { status: "REFUNDED", refundAmount: sum._sum.amount ?? 0 },
    });
    for (const it of ret.items)
      await tx.orderItem.update({
        where: { id: it.orderItemId },
        data: { returnedQty: { increment: it.quantity } },
      });
    await tx.returnHistory.create({
      data: {
        returnId,
        status: "REFUNDED",
        note: `Refunded ${(sum._sum.amount ?? 0).toString()}`,
        actorId: actor.id ?? null,
      },
    });
    return ret.orderId;
  });
  if (!orderId) return;
  await settleOrderAfterReturnChange(ctx, orderId, actor);
  await notifyReturn(ctx, orderId, "REFUNDED");
}

/** Proportional refund (minor units) for a set of return items: line total (incl. tax) * qty / orderedQty. */
export function proportionalRefundMinor(
  lines: { quantity: number; orderQuantity: number; lineTotal: string }[],
): number {
  let total = 0;
  for (const l of lines)
    total += Math.round((toMinor(l.lineTotal) * l.quantity) / Math.max(l.orderQuantity, 1));
  return total;
}
