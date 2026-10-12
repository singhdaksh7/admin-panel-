/**
 * REFUND SERVICE
 *
 *   createRefund(ctx, { paymentId, amount, reason?, returnId?, clientKey? }, actor): Promise<Refund>
 *       1. under a Payment row lock: validates PAID/PARTIALLY_REFUNDED, caps amount by
 *          (payment.amount - refundedAmount) (which already includes PENDING refunds), inserts Refund(PENDING)
 *          and reserves the amount in refundedAmount;
 *       2. calls provider.refundPayment with idempotencyKey = Refund.id (outside the DB tx);
 *       3. PROCESSED -> finalizeRefund; PENDING (manual provider) -> waits for settleRefund();
 *          FAILED/throw -> Refund FAILED, reservation released, AppError 502 with a safe message.
 *   settleRefund(ctx, refundId, "PROCESSED" | "FAILED", actor): admin/webhook resolution of a PENDING refund.
 *   finalizeRefund(ctx, refundId, actor): PENDING -> PROCESSED exactly once (guarded), updates payment + order
 *       payment status, writes an OrderEvent, notifies 'refund.processed', completes a linked return.
 */
import type { Refund } from "@kash-commerce/database";
import { AppError, fromMinor, toMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { Actor } from "../orders/service";
import { markPaymentStatus } from "../orders/service";
import { notify } from "../notifications/service";
import { finalizeReturnRefund } from "../returns/service";
import { customerNameOf, safeProviderMessage } from "./access";

export interface CreateRefundInput {
  paymentId: string;
  /** decimal string, e.g. "12.50" */
  amount: string;
  reason?: string | null;
  returnId?: string | null;
  /** optional client idempotency key (double-click protection) */
  clientKey?: string | null;
}

async function releaseReservation(ctx: AppContext, refundId: string): Promise<boolean> {
  return ctx.prisma.$transaction(async (tx) => {
    const r = await tx.refund.findUnique({ where: { id: refundId } });
    if (!r) return false;
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${r.paymentId} FOR UPDATE`;
    const upd = await tx.refund.updateMany({
      where: { id: refundId, status: "PENDING" },
      data: { status: "FAILED" },
    });
    if (upd.count !== 1) return false;
    const pay = await tx.payment.findUniqueOrThrow({ where: { id: r.paymentId } });
    await tx.payment.update({
      where: { id: pay.id },
      data: {
        refundedAmount: fromMinor(
          Math.max(0, toMinor(pay.refundedAmount.toFixed(2)) - toMinor(r.amount.toFixed(2))),
        ),
      },
    });
    return true;
  });
}

export async function finalizeRefund(
  ctx: AppContext,
  refundId: string,
  actor: Actor,
  providerRefundId?: string,
): Promise<Refund> {
  const done = await ctx.prisma.$transaction(async (tx) => {
    const r = await tx.refund.findUnique({ where: { id: refundId } });
    if (!r) throw AppError.notFound("Refund");
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${r.paymentId} FOR UPDATE`;
    const upd = await tx.refund.updateMany({
      where: { id: refundId, status: "PENDING" },
      data: { status: "PROCESSED", ...(providerRefundId ? { providerRefundId } : {}) },
    });
    if (upd.count !== 1) return null; // already finalized / failed: idempotent
    const pay = await tx.payment.findUniqueOrThrow({ where: { id: r.paymentId } });
    const sum = await tx.refund.aggregate({
      where: { paymentId: pay.id, status: "PROCESSED" },
      _sum: { amount: true },
    });
    const processed = toMinor((sum._sum.amount ?? 0).toString());
    const status = processed >= toMinor(pay.amount.toFixed(2)) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    return { refund: r, payment: pay, status } as const;
  });
  const current = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (!done) return current;

  const { payment, status } = done;
  const order = await markPaymentStatus(
    ctx,
    { orderId: payment.orderId, paymentId: payment.id, status },
    actor,
  );
  await ctx.prisma.orderEvent.create({
    data: {
      orderId: payment.orderId,
      type: "REFUND_PROCESSED",
      message: `Refund of ${current.amount.toFixed(2)} ${payment.currency} processed`,
      actorType: actor.type,
      actorId: actor.id ?? null,
      data: { refundId, paymentId: payment.id, returnId: current.returnId },
    },
  });
  if (current.returnId) await finalizeReturnRefund(ctx, current.returnId, actor);
  await notify(ctx, "refund.processed", order.email, {
    name: customerNameOf(order),
    orderNumber: order.orderNumber,
    amount: current.amount.toFixed(2),
    currency: payment.currency,
  });
  return current;
}

export async function createRefund(
  ctx: AppContext,
  input: CreateRefundInput,
  actor: Actor,
): Promise<Refund> {
  const amountMinor = toMinor(input.amount);
  if (amountMinor <= 0) throw AppError.validation("Refund amount must be greater than zero");

  // optional client-level idempotency (double-click / retry safe)
  const idemKey = input.clientKey ? `refund:${input.paymentId}:${input.clientKey}` : null;
  if (idemKey) {
    try {
      await ctx.prisma.idempotencyKey.create({
        data: { key: idemKey, scope: "refund", requestHash: String(amountMinor) },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      for (let i = 0; i < 25; i++) {
        const row = await ctx.prisma.idempotencyKey.findUnique({ where: { key: idemKey } });
        const refundId = (row?.response as { refundId?: string } | null)?.refundId;
        if (refundId) return ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
        await new Promise((r) => setTimeout(r, 200));
      }
      throw AppError.conflict("A refund with this idempotency key is in progress");
    }
  }

  let refund: Refund;
  try {
    refund = await ctx.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Payment" WHERE "id" = ${input.paymentId} FOR UPDATE`;
      if (!rows.length) throw AppError.notFound("Payment");
      const pay = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
      if (pay.status !== "PAID" && pay.status !== "PARTIALLY_REFUNDED")
        throw AppError.conflict(`A ${pay.status} payment cannot be refunded`);
      const refundable = toMinor(pay.amount.toFixed(2)) - toMinor(pay.refundedAmount.toFixed(2));
      if (amountMinor > refundable)
        throw AppError.validation("Refund exceeds the refundable balance", {
          refundable: fromMinor(Math.max(0, refundable)),
        });
      if (input.returnId) {
        const dup = await tx.refund.count({
          where: { returnId: input.returnId, status: { in: ["PENDING", "PROCESSED"] } },
        });
        if (dup) throw AppError.conflict("This return already has a refund");
      }
      const created = await tx.refund.create({
        data: {
          paymentId: pay.id,
          returnId: input.returnId ?? null,
          amount: fromMinor(amountMinor),
          reason: input.reason ?? null,
          status: "PENDING",
        },
      });
      await tx.payment.update({
        where: { id: pay.id },
        data: { refundedAmount: fromMinor(toMinor(pay.refundedAmount.toFixed(2)) + amountMinor) },
      });
      return created;
    });
  } catch (err) {
    if (idemKey)
      await ctx.prisma.idempotencyKey
        .deleteMany({ where: { key: idemKey } })
        .catch(() => undefined);
    throw err;
  }
  if (idemKey)
    await ctx.prisma.idempotencyKey
      .update({ where: { key: idemKey }, data: { response: { refundId: refund.id } } })
      .catch(() => undefined);

  const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
  const provider = ctx.providers.payment[payment.provider];
  const fail = async (err: unknown): Promise<never> => {
    ctx.logger.error({ err, refundId: refund.id }, "refund failed at provider");
    await releaseReservation(ctx, refund.id);
    throw new AppError(
      502,
      "PROVIDER_ERROR",
      safeProviderMessage(err, "The payment provider could not process this refund"),
      { refundId: refund.id },
    );
  };
  if (!provider) return fail(new Error("provider not registered"));
  let result;
  try {
    result = await provider.refundPayment({
      providerPaymentId: payment.providerPaymentId ?? payment.providerOrderId ?? payment.id,
      amount: fromMinor(amountMinor),
      currency: payment.currency,
      reason: input.reason ?? undefined,
      idempotencyKey: refund.id,
    });
  } catch (err) {
    return fail(err);
  }
  if (result.status === "FAILED") return fail(new Error("provider reported refund failure"));
  await ctx.prisma.refund.update({
    where: { id: refund.id },
    data: { providerRefundId: result.providerRefundId },
  });
  if (result.status === "PROCESSED")
    return finalizeRefund(ctx, refund.id, actor, result.providerRefundId);
  await ctx.prisma.orderEvent.create({
    data: {
      orderId: payment.orderId,
      type: "REFUND_PENDING",
      message: `Refund of ${fromMinor(amountMinor)} ${payment.currency} initiated`,
      actorType: actor.type,
      actorId: actor.id ?? null,
      data: { refundId: refund.id },
    },
  });
  return ctx.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Resolves a PENDING refund (manual provider, or an async provider callback). */
export async function settleRefund(
  ctx: AppContext,
  refundId: string,
  to: "PROCESSED" | "FAILED",
  actor: Actor,
): Promise<Refund> {
  const r = await ctx.prisma.refund.findUnique({ where: { id: refundId } });
  if (!r) throw AppError.notFound("Refund");
  if (r.status === to) return r;
  if (r.status !== "PENDING")
    throw AppError.conflict(`Refund is already ${r.status} and cannot be changed`);
  if (to === "PROCESSED") return finalizeRefund(ctx, refundId, actor);
  await releaseReservation(ctx, refundId);
  const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } });
  await ctx.prisma.orderEvent.create({
    data: {
      orderId: payment.orderId,
      type: "REFUND_FAILED",
      message: `Refund of ${r.amount.toFixed(2)} ${payment.currency} marked failed`,
      actorType: actor.type,
      actorId: actor.id ?? null,
      data: { refundId },
    },
  });
  return ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
}
