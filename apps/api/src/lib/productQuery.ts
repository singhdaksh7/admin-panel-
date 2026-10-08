import type { Prisma, PrismaClient } from "@kash-commerce/database";

/**
 * SINGLE SOURCE OF TRUTH for "which products does the storefront see" and "how storefront filter
 * query params map to a Prisma where". Used by the product list API *and* by facet counts, so
 * counts always match the list.
 *
 * Query grammar (all optional):
 *   q=text                      title / short description / SKU contains
 *   category=slug               category + all descendants
 *   collection=slug             manual collection membership
 *   tag=slug[,slug]             any of
 *   minPrice / maxPrice         against ACTIVE variant price
 *   inStock=true                at least one active variant available (or backorder/untracked)
 *   attr.<attributeSlug>=v1,v2  attribute value slugs (variant OR product-level), any-of within group
 *   prop.<key>=v1,v2            Product.properties[key] string equality, any-of
 */

export function publishedWhere(now = new Date()): Prisma.ProductWhereInput {
  return {
    status: "ACTIVE",
    AND: [
      { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
      { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
    ],
  };
}

export interface ParsedFilters {
  q?: string;
  category?: string;
  collection?: string;
  tags: string[];
  minPrice?: string;
  maxPrice?: string;
  inStock: boolean;
  attrs: Record<string, string[]>;
  props: Record<string, string[]>;
}

const csv = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .filter((x): x is string => typeof x === "string")
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

const money = (v: unknown): string | undefined =>
  typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v) ? v : undefined;

export function parseFilters(query: Record<string, unknown>): ParsedFilters {
  const attrs: Record<string, string[]> = {};
  const props: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith("attr.")) {
      const vals = csv(v);
      if (vals.length) attrs[k.slice(5)] = vals;
    } else if (k.startsWith("prop.")) {
      const vals = csv(v);
      if (vals.length) props[k.slice(5)] = vals;
    }
  }
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined;
  return {
    q: str(query.q),
    category: str(query.category),
    collection: str(query.collection),
    tags: csv(query.tag),
    minPrice: money(query.minPrice),
    maxPrice: money(query.maxPrice),
    inStock: query.inStock === "true" || query.inStock === "1",
    attrs,
    props,
  };
}

/** category id + all descendant ids (iterative; categories are a small table). */
export async function categoryTreeIds(prisma: PrismaClient, rootId: string): Promise<string[]> {
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
  const children = new Map<string, string[]>();
  for (const c of all) {
    if (c.parentId) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c.id]);
  }
  const out = [rootId];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
  return out;
}

/** Facet group ids that can be omitted from a where (for "counts ignore own selection"). */
export type FacetKey =
  "category" | "collection" | "price" | "stock" | "tag" | `attr.${string}` | `prop.${string}`;

export async function buildProductWhere(
  prisma: PrismaClient,
  f: ParsedFilters,
  opts: { omit?: Set<FacetKey>; now?: Date } = {},
): Promise<Prisma.ProductWhereInput> {
  const omit = opts.omit ?? new Set<FacetKey>();
  const and: Prisma.ProductWhereInput[] = [publishedWhere(opts.now)];

  if (f.q) {
    and.push({
      OR: [
        { title: { contains: f.q, mode: "insensitive" } },
        { shortDescription: { contains: f.q, mode: "insensitive" } },
        { variants: { some: { sku: { contains: f.q, mode: "insensitive" } } } },
      ],
    });
  }
  if (f.category && !omit.has("category")) {
    const cat = await prisma.category.findFirst({
      where: { slug: f.category, isActive: true },
      select: { id: true },
    });
    and.push(
      cat ? { categoryId: { in: await categoryTreeIds(prisma, cat.id) } } : { id: "__none__" },
    );
  }
  if (f.collection && !omit.has("collection")) {
    and.push({ collections: { some: { collection: { slug: f.collection, isActive: true } } } });
  }
  if (f.tags.length && !omit.has("tag")) {
    and.push({ tags: { some: { tag: { slug: { in: f.tags } } } } });
  }
  if ((f.minPrice || f.maxPrice) && !omit.has("price")) {
    and.push({
      variants: {
        some: {
          isActive: true,
          price: {
            ...(f.minPrice ? { gte: f.minPrice } : {}),
            ...(f.maxPrice ? { lte: f.maxPrice } : {}),
          },
        },
      },
    });
  }
  if (f.inStock && !omit.has("stock")) {
    and.push({
      variants: {
        some: {
          isActive: true,
          OR: [
            { inventory: null },
            { inventory: { trackInventory: false } },
            { inventory: { allowBackorder: true } },
            { inventory: { onHand: { gt: 0 } } }, // refined precisely (onHand - reserved) in service layer
          ],
        },
      },
    });
  }
  for (const [attrSlug, values] of Object.entries(f.attrs)) {
    if (omit.has(`attr.${attrSlug}`)) continue;
    const match = { attributeValue: { slug: { in: values }, attribute: { slug: attrSlug } } };
    and.push({
      OR: [
        { attributeValues: { some: match } },
        { variants: { some: { isActive: true, attributes: { some: match } } } },
      ],
    });
  }
  for (const [key, values] of Object.entries(f.props)) {
    if (omit.has(`prop.${key}`)) continue;
    and.push({ OR: values.map((v) => ({ properties: { path: [key], equals: v } })) });
  }
  return { AND: and };
}
