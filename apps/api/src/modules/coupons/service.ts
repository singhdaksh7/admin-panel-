/**
 * Coupon validation / redemption.
 *
 *   validateCoupon(db, { code, lines, subtotalMinor, customerId?, email?, now? })
 *     -> { coupon, discountMinor, eligibleSubtotalMinor, lineDiscounts }   (lineDiscounts aligned to `lines`)
 *     throws AppError(422) whose `details.reason` is one of CouponReason.
 *   redeemCoupon(tx, { couponId, orderId, customerId?, email?, amountMinor })
 *     race-safe: conditional UPDATE enforces usageLimit; per-customer limit re-checked under the row lock.
 *   releaseCouponRedemption(tx, orderId)  — undo on cancellation.
 */
import type { PrismaClient, Tx, Coupon } from "@kash-commerce/database";
import { AppError, percentOf, toMinor } from "@kash-commerce/shared";
import { allocateProportionally } from "../tax/engine";

export type CouponReason =
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "USAGE_LIMIT_REACHED"
  | "PER_CUSTOMER_LIMIT_REACHED"
  | "MIN_ORDER_NOT_MET"
  | "NOT_APPLICABLE"
  | "DISABLED";

const MESSAGES: Record<CouponReason, string> = {
  NOT_FOUND: "Coupon code is not valid",
  INACTIVE: "Coupon is not active",
  NOT_STARTED: "Coupon is not yet valid",
  EXPIRED: "Coupon has expired",
  USAGE_LIMIT_REACHED: "Coupon usage limit has been reached",
  PER_CUSTOMER_LIMIT_REACHED: "You have already used this coupon the maximum number of times",
  MIN_ORDER_NOT_MET: "Order total is below the minimum required for this coupon",
  NOT_APPLICABLE: "Coupon does not apply to any item in your cart",
  DISABLED: "Coupons are disabled",
};

export function couponError(reason: CouponReason, extra?: Record<string, unknown>) {
  return new AppError(422, "VALIDATION_ERROR", MESSAGES[reason], { reason, ...extra });
}

type Db = PrismaClient | Tx;

export const normalizeCode = (code: string) => code.trim().toUpperCase();

export interface CouponLine {
  productId: string;
  categoryId: string | null;
  lineTotalMinor: number; // unit * qty, pre-discount
}

export interface CouponValidation {
  coupon: Coupon;
  discountMinor: number;
  eligibleSubtotalMinor: number;
  lineDiscounts: number[];
}

async function descendantIds(db: Db, roots: string[]): Promise<Set<string>> {
  if (!roots.length) return new Set();
  const all = await db.category.findMany({ select: { id: true, parentId: true } });
  const children = new Map<string, string[]>();
  for (const c of all)
    if (c.parentId) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c.id]);
  const out = [...roots];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
  return new Set(out);
}

export async function validateCoupon(
  db: Db,
  input: {
    code: string;
    lines: CouponLine[];
    subtotalMinor: number;
    customerId?: string | null;
    email?: string | null;
    now?: Date;
  },
): Promise<CouponValidation> {
  const now = input.now ?? new Date();
  const coupon = await db.coupon.findUnique({
    where: { code: normalizeCode(input.code) },
    include: { products: true, categories: true },
  });
  if (!coupon) throw couponError("NOT_FOUND");
  if (!coupon.isActive) throw couponError("INACTIVE");
  if (coupon.startsAt && coupon.startsAt > now) throw couponError("NOT_STARTED");
  if (coupon.endsAt && coupon.endsAt < now) throw couponError("EXPIRED");
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit)
    throw couponError("USAGE_LIMIT_REACHED");
  if (coupon.minOrderAmount && input.subtotalMinor < toMinor(coupon.minOrderAmount.toString()))
    throw couponError("MIN_ORDER_NOT_MET", { minOrderAmount: coupon.minOrderAmount.toString() });

  if (coupon.perCustomerLimit != null && (input.customerId || input.email)) {
    const used = await countUses(db, coupon.id, input.customerId, input.email);
    if (used >= coupon.perCustomerLimit) throw couponError("PER_CUSTOMER_LIMIT_REACHED");
  }

  // eligibility
  const productIds = new Set(coupon.products.map((p) => p.productId));
  const catIds = await descendantIds(
    db,
    coupon.categories.map((c) => c.categoryId),
  );
  const restricted = productIds.size > 0 || catIds.size > 0;
  const eligible = input.lines.map(
    (l) =>
      !restricted ||
      productIds.has(l.productId) ||
      (l.categoryId != null && catIds.has(l.categoryId)),
  );
  const eligibleSubtotal = input.lines.reduce(
    (a, l, i) => a + (eligible[i] ? l.lineTotalMinor : 0),
    0,
  );
  if (eligibleSubtotal <= 0) throw couponError("NOT_APPLICABLE");

  let discount =
    coupon.discountType === "FIXED"
      ? toMinor(coupon.value.toString())
      : percentOf(eligibleSubtotal, Number(coupon.value));
  if (coupon.maxDiscount) discount = Math.min(discount, toMinor(coupon.maxDiscount.toString()));
  discount = Math.min(discount, eligibleSubtotal);

  const weights = input.lines.map((l, i) => (eligible[i] ? l.lineTotalMinor : 0));
  return {
    coupon,
    discountMinor: discount,
    eligibleSubtotalMinor: eligibleSubtotal,
    lineDiscounts: allocateProportionally(discount, weights),
  };
}

async function countUses(
  db: Db,
  couponId: string,
  customerId?: string | null,
  email?: string | null,
) {
  const or: Array<Record<string, string>> = [];
  if (customerId) or.push({ customerId });
  if (email) or.push({ email: email.toLowerCase() });
  if (!or.length) return 0;
  return db.couponRedemption.count({ where: { couponId, OR: or } });
}

export async function redeemCoupon(
  tx: Tx,
  input: {
    couponId: string;
    orderId: string;
    customerId?: string | null;
    email?: string | null;
    amountMinor: number;
  },
): Promise<void> {
  const updated = await tx.$executeRaw`
    UPDATE "Coupon" SET "usedCount" = "usedCount" + 1, "updatedAt" = now()
    WHERE "id" = ${input.couponId} AND "isActive"
      AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
  if (updated === 0) throw couponError("USAGE_LIMIT_REACHED");
  // we now hold the coupon row lock => per-customer count is race-free
  const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: input.couponId } });
  if (coupon.perCustomerLimit != null) {
    const used = await countUses(tx, coupon.id, input.customerId, input.email);
    if (used >= coupon.perCustomerLimit) throw couponError("PER_CUSTOMER_LIMIT_REACHED");
  }
  await tx.couponRedemption.create({
    data: {
      couponId: input.couponId,
      orderId: input.orderId,
      customerId: input.customerId ?? null,
      email: input.email ? input.email.toLowerCase() : null,
      amount: (input.amountMinor / 100).toFixed(2),
    },
  });
}

export async function releaseCouponRedemption(tx: Tx, orderId: string): Promise<void> {
  const r = await tx.couponRedemption.findUnique({ where: { orderId } });
  if (!r) return;
  await tx.couponRedemption.delete({ where: { id: r.id } });
  await tx.$executeRaw`UPDATE "Coupon" SET "usedCount" = GREATEST("usedCount" - 1, 0) WHERE "id" = ${r.couponId}`;
}
