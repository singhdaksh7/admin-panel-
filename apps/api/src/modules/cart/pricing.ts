/**
 * Server-side pricing of cart/checkout lines. Prices ALWAYS come from the database;
 * nothing the client sends is trusted except variantId + quantity.
 */
import type { PrismaClient, Tx } from "@kash-commerce/database";
import { AppError, toMinor } from "@kash-commerce/shared";
import { publishedWhere } from "../../lib/productQuery";

export const MAX_LINE_QTY = 99;

export type LineProblem = "NOT_FOUND" | "UNAVAILABLE" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK";

export interface PricedLine {
  variantId: string;
  productId: string;
  categoryId: string | null;
  productTitle: string;
  variantTitle: string | null;
  sku: string;
  imageUrl: string | null;
  attributes: Array<{ name: string; value: string }>;
  unitPriceMinor: number;
  quantity: number;
  taxRate: number | null;
  hsnCode: string | null;
  /** units that can be bought right now; null => unlimited (untracked / backorder) */
  available: number | null;
  problems: LineProblem[];
}

type Db = PrismaClient | Tx;

export async function loadPricedLines(
  db: Db,
  items: Array<{ variantId: string; quantity: number }>,
  urlFor: (storageKey: string) => string,
): Promise<PricedLine[]> {
  if (!items.length) return [];
  const ids = [...new Set(items.map((i) => i.variantId))];
  const variants = await db.productVariant.findMany({
    where: { id: { in: ids } },
    include: {
      product: {
        include: {
          taxClass: true,
          images: { orderBy: { position: "asc" }, take: 1, include: { media: true } },
        },
      },
      inventory: true,
      attributes: { include: { attributeValue: { include: { attribute: true } } } },
    },
  });
  const published = new Set(
    (
      await db.product.findMany({
        where: { id: { in: [...new Set(variants.map((v) => v.productId))] }, ...publishedWhere() },
        select: { id: true },
      })
    ).map((p) => p.id),
  );
  const byId = new Map(variants.map((v) => [v.id, v]));
  const out: PricedLine[] = [];
  for (const it of items) {
    const v = byId.get(it.variantId);
    if (!v) continue; // callers treat missing variants via `missingVariantIds`
    const problems: LineProblem[] = [];
    if (!v.isActive || !published.has(v.productId)) problems.push("UNAVAILABLE");
    const inv = v.inventory;
    let available: number | null = null;
    if (inv && inv.trackInventory && !inv.allowBackorder) {
      available = Math.max(0, inv.onHand - inv.reserved);
      if (available === 0) problems.push("OUT_OF_STOCK");
      else if (it.quantity > available) problems.push("INSUFFICIENT_STOCK");
    }
    const img = v.product.images[0]?.media;
    out.push({
      variantId: v.id,
      productId: v.productId,
      categoryId: v.product.categoryId,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      imageUrl: img ? urlFor(img.storageKey) : null,
      attributes: v.attributes.map((a) => ({
        name: a.attributeValue.attribute.name,
        value: a.attributeValue.value,
      })),
      unitPriceMinor: toMinor(v.price.toString()),
      quantity: it.quantity,
      taxRate: v.product.taxClass ? Number(v.product.taxClass.rate) : null,
      hsnCode: v.product.taxClass?.hsnCode ?? null,
      available,
      problems,
    });
  }
  return out;
}

/** Throws a descriptive error when any line cannot be purchased (checkout). */
export function assertPurchasable(
  requested: Array<{ variantId: string }>,
  lines: PricedLine[],
): void {
  const have = new Set(lines.map((l) => l.variantId));
  const missing = requested.filter((r) => !have.has(r.variantId)).map((r) => r.variantId);
  if (missing.length)
    throw AppError.conflict("Some items are no longer available", {
      items: missing.map((variantId) => ({ variantId, problem: "NOT_FOUND" })),
    });
  const bad = lines.filter((l) => l.problems.length);
  if (!bad.length) return;
  const stockOnly = bad.every((l) =>
    l.problems.every((p) => p === "OUT_OF_STOCK" || p === "INSUFFICIENT_STOCK"),
  );
  const details = {
    items: bad.map((l) => ({
      variantId: l.variantId,
      title: l.productTitle,
      problems: l.problems,
      available: l.available,
    })),
  };
  throw stockOnly
    ? AppError.outOfStock("Some items are out of stock", details)
    : AppError.conflict("Some items are no longer available", details);
}
