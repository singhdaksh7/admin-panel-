import type { PrismaClient } from "@kash-commerce/database";

export interface RatingAggregate {
  average: number;
  count: number;
  /** keys "1".."5" */
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
}

export const emptyAggregate = (): RatingAggregate => ({
  average: 0,
  count: 0,
  distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
});

/**
 * Approved-review aggregates for many products in ONE query. Products without reviews are present
 * in the result with a zeroed aggregate. `average` is rounded to 1 decimal.
 */
export async function getRatingAggregates(
  prisma: PrismaClient,
  productIds: string[],
): Promise<Map<string, RatingAggregate>> {
  const out = new Map<string, RatingAggregate>();
  for (const id of productIds) out.set(id, emptyAggregate());
  if (!productIds.length) return out;
  const rows = await prisma.review.groupBy({
    by: ["productId", "rating"],
    where: { productId: { in: productIds }, status: "APPROVED" },
    _count: { _all: true },
  });
  const sums = new Map<string, number>();
  for (const r of rows) {
    const a = out.get(r.productId) ?? emptyAggregate();
    a.distribution[String(r.rating) as keyof RatingAggregate["distribution"]] = r._count._all;
    a.count += r._count._all;
    sums.set(r.productId, (sums.get(r.productId) ?? 0) + r.rating * r._count._all);
    out.set(r.productId, a);
  }
  for (const [id, a] of out) {
    if (a.count) a.average = Math.round(((sums.get(id) ?? 0) / a.count) * 10) / 10;
  }
  return out;
}
