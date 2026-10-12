import type { AppContext } from "../../context";
import { categoryTreeIds, publishedWhere } from "../../lib/productQuery";
import { getRatingAggregates } from "../reviews/service";

export const isPublishedNow = (
  p: { status: string; publishAt: Date | null },
  now = new Date(),
): boolean => p.status === "PUBLISHED" && (!p.publishAt || p.publishAt <= now);

export const sectionVisibleWhere = (now: Date) => ({
  isEnabled: true,
  AND: [
    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
  ],
});

/** Map of mediaId -> public URL. */
export async function mediaUrlMap(
  ctx: AppContext,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const list = [...new Set([...ids].filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!list.length) return out;
  const rows = await ctx.prisma.media.findMany({
    where: { id: { in: list } },
    select: { id: true, storageKey: true },
  });
  for (const m of rows) out.set(m.id, ctx.providers.storage.url(m.storageKey));
  return out;
}

/** Deep-copy `content`, adding `<prefix>Url` next to every `<prefix>MediaId`. */
export function withMediaUrls<T>(content: T, urls: Map<string, string>): T {
  if (Array.isArray(content)) return content.map((c) => withMediaUrls(c, urls)) as T;
  if (content && typeof content === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
      out[k] = withMediaUrls(v, urls);
      if (k.endsWith("MediaId") && typeof v === "string") {
        out[`${k.slice(0, -"MediaId".length)}Url`] = urls.get(v) ?? null;
      }
    }
    return out as T;
  }
  return content;
}

export interface ProductCard {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  shortDescription: string | null;
  price: string | null;
  compareAtPrice: string | null;
  imageUrl: string | null;
  isNew: boolean;
  isFeatured: boolean;
  rating: { average: number; count: number };
}

/** Public product card projection for already-published product ids (order preserved). */
export async function productCards(ctx: AppContext, ids: string[]): Promise<ProductCard[]> {
  if (!ids.length) return [];
  const rows = await ctx.prisma.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      slug: true,
      title: true,
      brand: true,
      shortDescription: true,
      isNew: true,
      isFeatured: true,
      variants: {
        where: { isActive: true },
        orderBy: [{ price: "asc" }],
        select: { price: true, compareAtPrice: true },
        take: 1,
      },
      images: { orderBy: { position: "asc" }, take: 1, select: { media: true } },
    },
  });
  const agg = await getRatingAggregates(ctx.prisma, ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const v = r.variants[0];
    const a = agg.get(id);
    return [
      {
        id: r.id,
        slug: r.slug,
        title: r.title,
        brand: r.brand,
        shortDescription: r.shortDescription,
        price: v ? v.price.toString() : null,
        compareAtPrice: v?.compareAtPrice ? v.compareAtPrice.toString() : null,
        imageUrl: r.images[0] ? ctx.providers.storage.url(r.images[0].media.storageKey) : null,
        isNew: r.isNew,
        isFeatured: r.isFeatured,
        rating: { average: a?.average ?? 0, count: a?.count ?? 0 },
      },
    ];
  });
}

type Content = Record<string, unknown>;
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

async function resolveProductGrid(ctx: AppContext, c: Content) {
  const prisma = ctx.prisma;
  const limit = Number(c.limit ?? 8);
  const explicitIds = arr(c.productIds);
  const explicitSlugs = arr(c.productSlugs);
  const and: object[] = [];
  let order = String(c.sort ?? "newest");
  if (explicitIds.length || explicitSlugs.length) {
    and.push({
      OR: [
        ...(explicitIds.length ? [{ id: { in: explicitIds } }] : []),
        ...(explicitSlugs.length ? [{ slug: { in: explicitSlugs } }] : []),
      ],
    });
    order = "manual";
  }
  if (typeof c.categorySlug === "string" || typeof c.categoryId === "string") {
    const cat = await prisma.category.findFirst({
      where: {
        isActive: true,
        ...(c.categoryId ? { id: c.categoryId as string } : { slug: c.categorySlug as string }),
      },
      select: { id: true },
    });
    and.push(
      cat ? { categoryId: { in: await categoryTreeIds(prisma, cat.id) } } : { id: "__none__" },
    );
  }
  if (typeof c.collectionSlug === "string")
    and.push({
      collections: { some: { collection: { slug: c.collectionSlug, isActive: true } } },
    });
  if (c.featuredOnly) and.push({ isFeatured: true });
  const where = { AND: [publishedWhere(), ...and] };
  let found: { id: string }[];
  if (order === "manual" && (explicitIds.length || explicitSlugs.length)) {
    const rows = await prisma.product.findMany({
      where,
      select: { id: true, slug: true },
    });
    const pos = (r: { id: string; slug: string }) => {
      const i = explicitIds.indexOf(r.id);
      return i >= 0 ? i : explicitIds.length + Math.max(0, explicitSlugs.indexOf(r.slug));
    };
    found = rows.sort((a, b) => pos(a) - pos(b)).slice(0, limit);
  } else {
    found = await prisma.product.findMany({
      where,
      select: { id: true },
      orderBy:
        order === "featured"
          ? [{ isFeatured: "desc" }, { createdAt: "desc" }]
          : [{ createdAt: "desc" }],
      take: limit,
    });
  }
  return productCards(
    ctx,
    found.map((f) => f.id),
  );
}

async function resolveCategoryGrid(ctx: AppContext, c: Content) {
  const limit = Number(c.limit ?? 8);
  const ids = arr(c.categoryIds);
  const slugs = arr(c.categorySlugs);
  const where: Record<string, unknown> = { isActive: true };
  if (ids.length || slugs.length) {
    where.OR = [
      ...(ids.length ? [{ id: { in: ids } }] : []),
      ...(slugs.length ? [{ slug: { in: slugs } }] : []),
    ];
  } else if (typeof c.parentSlug === "string") {
    where.parent = { slug: c.parentSlug };
  } else {
    where.parentId = null;
  }
  const rows = await ctx.prisma.category.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const explicit = ids.length || slugs.length;
  const ordered = explicit
    ? rows.sort(
        (a, b) =>
          (ids.indexOf(a.id) >= 0 ? ids.indexOf(a.id) : 1000 + slugs.indexOf(a.slug)) -
          (ids.indexOf(b.id) >= 0 ? ids.indexOf(b.id) : 1000 + slugs.indexOf(b.slug)),
      )
    : rows;
  const urls = await mediaUrlMap(
    ctx,
    ordered.map((r) => r.imageMediaId),
  );
  return ordered.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    url: `/category/${r.slug}`,
    imageUrl: r.imageMediaId ? (urls.get(r.imageMediaId) ?? null) : null,
  }));
}

export async function publishedBlogPosts(
  ctx: AppContext,
  opts: { limit: number; tag?: string; skip?: number },
) {
  const now = new Date();
  const where = {
    status: "PUBLISHED" as const,
    OR: [{ publishAt: null }, { publishAt: { lte: now } }],
    ...(opts.tag ? { tags: { has: opts.tag } } : {}),
  };
  const rows = await ctx.prisma.blogPost.findMany({
    where,
    orderBy: [{ publishAt: "desc" }, { createdAt: "desc" }],
    take: opts.limit,
    skip: opts.skip ?? 0,
  });
  const urls = await mediaUrlMap(
    ctx,
    rows.map((r) => r.coverMediaId),
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    authorName: r.authorName,
    tags: r.tags,
    coverUrl: r.coverMediaId ? (urls.get(r.coverMediaId) ?? null) : null,
    publishedAt: r.publishAt ?? r.createdAt,
  }));
}

async function resolveReviews(ctx: AppContext, c: Content) {
  const where: Record<string, unknown> = { status: "APPROVED" };
  if (typeof c.productSlug === "string")
    where.product = { slug: c.productSlug, ...publishedWhere() };
  else where.product = publishedWhere();
  if (typeof c.minRating === "number") where.rating = { gte: c.minRating };
  const rows = await ctx.prisma.review.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Number(c.limit ?? 6),
    select: {
      id: true,
      authorName: true,
      rating: true,
      title: true,
      body: true,
      verifiedPurchase: true,
      createdAt: true,
      product: { select: { slug: true, title: true } },
    },
  });
  return rows;
}

/** Attach `items` (resolved data) to the section types that need it. */
export async function resolveSectionContent(
  ctx: AppContext,
  type: string,
  content: Content,
): Promise<Content> {
  switch (type) {
    case "PRODUCT_GRID":
      return { ...content, items: await resolveProductGrid(ctx, content) };
    case "CATEGORY_GRID":
      return { ...content, items: await resolveCategoryGrid(ctx, content) };
    case "BLOG_PREVIEW":
      return {
        ...content,
        items: await publishedBlogPosts(ctx, {
          limit: Number(content.limit ?? 3),
          tag: content.tag as string | undefined,
        }),
      };
    case "REVIEWS":
      return { ...content, items: await resolveReviews(ctx, content) };
    default:
      return content;
  }
}
