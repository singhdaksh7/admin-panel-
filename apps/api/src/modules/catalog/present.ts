import { Prisma } from "@kash-commerce/database";
import { paginated, type PageParams } from "@kash-commerce/shared";
import type { AppContext } from "../../context";

/** Cap on the stock number exposed to storefronts. */
export const PUBLIC_STOCK_CAP = 20;

export type PublicSort = "newest" | "price_asc" | "price_desc" | "title" | "featured";
export const PUBLIC_SORTS: PublicSort[] = [
  "newest",
  "price_asc",
  "price_desc",
  "title",
  "featured",
];

export function parseSort(v: unknown): PublicSort {
  return typeof v === "string" && (PUBLIC_SORTS as string[]).includes(v)
    ? (v as PublicSort)
    : "newest";
}

interface StockLike {
  onHand: number;
  reserved: number;
  trackInventory: boolean;
  allowBackorder: boolean;
}

/** Variants without an inventory row are treated as untracked (always purchasable). */
export function variantAvailability(inv: StockLike | null | undefined): {
  inStock: boolean;
  available: number;
} {
  if (!inv || !inv.trackInventory || inv.allowBackorder)
    return { inStock: true, available: PUBLIC_STOCK_CAP };
  const avail = Math.max(0, inv.onHand - inv.reserved);
  return { inStock: avail > 0, available: Math.min(PUBLIC_STOCK_CAP, avail) };
}

const mediaSelect = { storageKey: true, altText: true, width: true, height: true } as const;

export const listSelect = {
  id: true,
  title: true,
  slug: true,
  shortDescription: true,
  isFeatured: true,
  isNew: true,
  createdAt: true,
  category: { select: { name: true, slug: true } },
  images: {
    orderBy: { position: "asc" },
    take: 6,
    select: { media: { select: mediaSelect } },
  },
  variants: {
    where: { isActive: true },
    orderBy: { position: "asc" },
    select: {
      id: true,
      price: true,
      compareAtPrice: true,
      inventory: {
        select: { onHand: true, reserved: true, trackInventory: true, allowBackorder: true },
      },
    },
  },
} satisfies Prisma.ProductSelect;

export type ListRow = Prisma.ProductGetPayload<{ select: typeof listSelect }>;

export async function storeCurrency(ctx: AppContext): Promise<string> {
  const s = await ctx.prisma.storeSettings.findUnique({
    where: { id: "store" },
    select: { currency: true },
  });
  return s?.currency ?? "USD";
}

export async function ratingsFor(
  ctx: AppContext,
  productIds: string[],
): Promise<Map<string, { average: number; count: number }>> {
  const out = new Map<string, { average: number; count: number }>();
  if (!productIds.length) return out;
  const groups = await ctx.prisma.review.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, status: "APPROVED" },
    _avg: { rating: true },
    _count: { _all: true },
  });
  for (const g of groups)
    out.set(g.productId, {
      average: Math.round((g._avg.rating ?? 0) * 10) / 10,
      count: g._count._all,
    });
  return out;
}

export function presentImage(
  ctx: AppContext,
  m: { storageKey: string; altText: string | null; width: number | null; height: number | null },
) {
  return {
    url: ctx.providers.storage.url(m.storageKey),
    alt: m.altText,
    width: m.width,
    height: m.height,
  };
}

export function presentListItem(
  ctx: AppContext,
  r: ListRow,
  currency: string,
  rating: { average: number; count: number } | undefined,
) {
  let min: ListRow["variants"][number] | undefined;
  for (const v of r.variants) if (!min || v.price.lt(min.price)) min = v;
  const images = r.images.map((i) => presentImage(ctx, i.media));
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    shortDescription: r.shortDescription,
    price: min ? min.price.toFixed(2) : null,
    compareAtPrice:
      min?.compareAtPrice && min.compareAtPrice.gt(min.price)
        ? min.compareAtPrice.toFixed(2)
        : null,
    currency,
    image: images[0]?.url ?? null,
    images,
    category: r.category,
    inStock: r.variants.some((v) => variantAvailability(v.inventory).inStock),
    isFeatured: r.isFeatured,
    isNew: r.isNew,
    rating: rating ?? { average: 0, count: 0 },
  };
}

/**
 * Paginated storefront listing for an already-built `where` (must include publishedWhere()).
 * Price sorts group variants by min active price (single grouped query), other sorts use the DB order.
 */
export async function listPublicProducts(
  ctx: AppContext,
  where: Prisma.ProductWhereInput,
  sort: PublicSort,
  pg: PageParams,
  orderOverride?: Prisma.ProductOrderByWithRelationInput[],
) {
  const p = ctx.prisma;
  const full: Prisma.ProductWhereInput = {
    AND: [where, { variants: { some: { isActive: true } } }],
  };
  let rows: ListRow[];
  let total: number;

  if (sort === "price_asc" || sort === "price_desc") {
    const mins = await p.productVariant.groupBy({
      by: ["productId"],
      where: { isActive: true, product: full },
      _min: { price: true },
    });
    const dir = sort === "price_asc" ? 1 : -1;
    mins.sort(
      (a, b) =>
        dir * (a._min.price!.comparedTo(b._min.price!) || 0) ||
        (a.productId < b.productId ? -1 : 1),
    );
    total = mins.length;
    const ids = mins
      .slice((pg.page - 1) * pg.pageSize, pg.page * pg.pageSize)
      .map((m) => m.productId);
    const found = await p.product.findMany({ where: { id: { in: ids } }, select: listSelect });
    const byId = new Map(found.map((f) => [f.id, f]));
    rows = ids.map((i) => byId.get(i)).filter((x): x is ListRow => !!x);
  } else {
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      orderOverride ??
      (sort === "title"
        ? [{ title: "asc" }, { id: "asc" }]
        : sort === "featured"
          ? [{ isFeatured: "desc" }, { createdAt: "desc" }, { id: "asc" }]
          : [{ createdAt: "desc" }, { id: "asc" }]);
    [rows, total] = await Promise.all([
      p.product.findMany({
        where: full,
        select: listSelect,
        orderBy,
        skip: (pg.page - 1) * pg.pageSize,
        take: pg.pageSize,
      }),
      p.product.count({ where: full }),
    ]);
  }
  return presentPage(ctx, rows, total, pg);
}

export async function presentPage(ctx: AppContext, rows: ListRow[], total: number, pg: PageParams) {
  const [currency, ratings] = await Promise.all([
    storeCurrency(ctx),
    ratingsFor(
      ctx,
      rows.map((r) => r.id),
    ),
  ]);
  return paginated(
    rows.map((r) => presentListItem(ctx, r, currency, ratings.get(r.id))),
    total,
    pg,
  );
}
