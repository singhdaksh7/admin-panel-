import type { Request } from "express";
import { AppError } from "@kash-commerce/shared";
import type { Order, PrismaClient } from "@kash-commerce/database";
import { safeEqual } from "../../lib/crypto";

/**
 * Guest/customer access rule shared by every public order-scoped endpoint:
 * the caller must be the owning customer (session) OR supply the order's email.
 * Comparisons always run (no early exit) so existence is not observable through timing.
 */
export function canAccessOrder(
  req: Request,
  order: { email: string; customerId: string | null } | null,
  suppliedEmail?: string | null,
): boolean {
  const emailOk = safeEqual(
    (order?.email ?? "\u0000not-an-email").toLowerCase(),
    (suppliedEmail ?? "").trim().toLowerCase() || "\u0001",
  );
  const owner = !!order && !!req.customer && order.customerId === req.customer.id;
  return !!order && (owner || emailOk);
}

/** Loads an order by number and enforces canAccessOrder; uniform 404 for missing AND forbidden. */
export async function loadAccessibleOrder(
  p: PrismaClient,
  req: Request,
  orderNumber: string,
  suppliedEmail?: string | null,
): Promise<Order> {
  const o = await p.order.findUnique({ where: { orderNumber: orderNumber.slice(0, 40) } });
  if (!canAccessOrder(req, o, suppliedEmail)) throw AppError.notFound("Order");
  return o!;
}

export function customerNameOf(o: { customerSnapshot: unknown }): string {
  return ((o.customerSnapshot ?? {}) as { name?: string }).name ?? "";
}

/** Safe, user-facing message for a provider failure (never raw upstream bodies). */
export function safeProviderMessage(err: unknown, fallback: string): string {
  if (err instanceof AppError && err.code === "PROVIDER_ERROR") return err.message.slice(0, 200);
  return fallback;
}
