import type { FilterGroup, Prisma, PrismaClient } from "@kash-commerce/database";
import {
  buildProductWhere,
  categoryTreeIds,
  parseFilters,
  type FacetKey,
  type ParsedFilters,
} from "../../lib/productQuery";

type Cat = { id: string; parentId: string | null };

const defKey = (g: Pick<FilterGroup, "source" | "attributeId" | "propertyKey">) =>
  `${g.source}:${g.attributeId ?? ""}:${g.propertyKey ?? ""}`;

/** [self, parent, grandparent, ...] */
export function ancestorChain(cats: Cat[], categoryId: string): string[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out: string[] = [];
  let cur = byId.get(categoryId);
  while (cur && !out.includes(cur.id)) {
    out.push(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/**
 * Effective filter groups for a category (null = global scope).
 *  - candidates: the category's own definitions + definitions of ancestors with inheritToChildren
 *  - per (source, attribute/property) the NEAREST definition wins; a disabled winner removes the group
 *  - if nothing at all is configured along the chain, global defaults (categoryId = null) apply
 */
export async function resolveFilterGroups(
  prisma: PrismaClient,
  categoryId: string | null,
): Promise<FilterGroup[]> {
  const cats = categoryId
    ? await prisma.category.findMany({ select: { id: true, parentId: true } })
    : [];
  const chain = categoryId ? ancestorChain(cats, categoryId) : [];
  const defs = await prisma.filterGroup.findMany({
    where: { OR: [{ categoryId: null }, ...(chain.length ? [{ categoryId: { in: chain } }] : [])] },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  const forCat = defs.filter((d) => d.categoryId !== null);
  const picked = new Map<string, FilterGroup>();
  chain.forEach((cid, depth) => {
    for (const d of forCat.filter((x) => x.categoryId === cid)) {
      if (depth > 0 && !d.inheritToChildren) continue;
      const k = defKey(d);
      if (!picked.has(k)) picked.set(k, d);
    }
  });
  let winners = [...picked.values()];
  if (!winners.length) winners = defs.filter((d) => d.categoryId === null);
  return winners
    .filter((g) => g.isEnabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export type GroupType = "multi" | "single" | "range" | "boolean";
export interface FilterOption {
  value: string;
  label: string;
  count: number;
  selected: boolean;
  meta?: unknown;
}
export interface FilterGroupOut {
  id: string;
  source: string;
  key: string;
  label: string;
  type: GroupType;
  open: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  options: FilterOption[];
  range?: { min: string | null; max: string | null };
}

const mono = (n: string): FacetKey => n as FacetKey;

export async function computeFilters(
  prisma: PrismaClient,
  query: Record<string, unknown>,
  now = new Date(),
) {
  const f = parseFilters(query);
  const device = query.device === "mobile" || query.device === "desktop" ? query.device : undefined;
  const category = f.category
    ? await prisma.category.findFirst({
        where: { slug: f.category, isActive: true },
        select: { id: true, name: true, slug: true, parentId: true },
      })
    : null;

  const groups = (await resolveFilterGroups(prisma, category?.id ?? null)).filter(
    (g) => !device || (device === "mobile" ? g.showMobile : g.showDesktop),
  );

  const whereOmit = (key: FacetKey) => buildProductWhere(prisma, f, { omit: new Set([key]), now });

  const attrIds = groups
    .filter((g) => g.source === "ATTRIBUTE" && g.attributeId)
    .map((g) => g.attributeId!);
  const attrs = attrIds.length
    ? await prisma.attribute.findMany({
        where: { id: { in: attrIds } },
        include: { values: { orderBy: [{ sortOrder: "asc" }, { value: "asc" }] } },
      })
    : [];
  const attrById = new Map(attrs.map((a) => [a.id, a]));

  const build = async (g: FilterGroup): Promise<FilterGroupOut | null> => {
    const base = {
      id: g.id,
      source: g.source,
      label: g.label,
      open: g.defaultOpen,
      showDesktop: g.showDesktop,
      showMobile: g.showMobile,
    };
    const multi: GroupType = g.multiSelect ? "multi" : "single";
    switch (g.source) {
      case "CATEGORY":
        return nonEmpty({
          ...base,
          key: "category",
          type: "single" as const,
          options: await categoryOptions(prisma, f, category?.id ?? null, now),
        });
      case "COLLECTION": {
        const where = await whereOmit("collection");
        const rows = await prisma.collectionProduct.groupBy({
          by: ["collectionId"],
          where: { product: where, collection: { isActive: true } },
          _count: { _all: true },
        });
        const counts = new Map(rows.map((r) => [r.collectionId, r._count._all]));
        const cols = await prisma.collection.findMany({
          where: { isActive: true },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        });
        const options = cols
          .map((c) => ({
            value: c.slug,
            label: c.name,
            count: counts.get(c.id) ?? 0,
            selected: f.collection === c.slug,
          }))
          .filter((o) => o.count > 0 || o.selected);
        return nonEmpty({ ...base, key: "collection", type: "single" as const, options });
      }
      case "TAG": {
        const where = await whereOmit("tag");
        const rows = await prisma.productTag.groupBy({
          by: ["tagId"],
          where: { product: where },
          _count: { _all: true },
        });
        const counts = new Map(rows.map((r) => [r.tagId, r._count._all]));
        const tags = await prisma.tag.findMany({ orderBy: { name: "asc" } });
        const options = tags
          .map((t) => ({
            value: t.slug,
            label: t.name,
            count: counts.get(t.id) ?? 0,
            selected: f.tags.includes(t.slug),
          }))
          .filter((o) => o.count > 0 || o.selected);
        return nonEmpty({ ...base, key: "tag", type: multi, options });
      }
      case "PRICE": {
        const where = await whereOmit("price");
        const agg = await prisma.productVariant.aggregate({
          where: { isActive: true, product: where },
          _min: { price: true },
          _max: { price: true },
        });
        if (agg._min.price === null) return null;
        return {
          ...base,
          key: "price",
          type: "range",
          options: [],
          range: { min: agg._min.price.toFixed(2), max: agg._max.price!.toFixed(2) },
        };
      }
      case "STOCK": {
        // the list for inStock=true is exactly "everything else + in stock"
        const where = await buildProductWhere(prisma, { ...f, inStock: true }, { now });
        const count = await prisma.product.count({ where });
        if (!count && !f.inStock) return null;
        return {
          ...base,
          key: "inStock",
          type: "boolean",
          options: [{ value: "true", label: g.label, count, selected: f.inStock }],
        };
      }
      case "ATTRIBUTE": {
        const attr = g.attributeId ? attrById.get(g.attributeId) : undefined;
        if (!attr) return null;
        const where = await whereOmit(mono(`attr.${attr.slug}`));
        const [pav, vav] = await Promise.all([
          prisma.productAttributeValue.findMany({
            where: { attributeValue: { attributeId: attr.id }, product: where },
            select: { productId: true, attributeValueId: true },
          }),
          prisma.variantAttributeValue.findMany({
            where: {
              attributeValue: { attributeId: attr.id },
              variant: { isActive: true, product: where },
            },
            select: { attributeValueId: true, variant: { select: { productId: true } } },
          }),
        ]);
        const sets = new Map<string, Set<string>>();
        const add = (v: string, pid: string) => {
          if (!sets.has(v)) sets.set(v, new Set());
          sets.get(v)!.add(pid);
        };
        pav.forEach((r) => add(r.attributeValueId, r.productId));
        vav.forEach((r) => add(r.attributeValueId, r.variant.productId));
        const sel = new Set(f.attrs[attr.slug] ?? []);
        const options = attr.values
          .map((v) => ({
            value: v.slug,
            label: v.value,
            count: sets.get(v.id)?.size ?? 0,
            selected: sel.has(v.slug),
            ...(v.meta ? { meta: v.meta } : {}),
          }))
          .filter((o) => o.count > 0 || o.selected);
        return nonEmpty({ ...base, key: `attr.${attr.slug}`, type: multi, options });
      }
      case "PROPERTY": {
        const key = g.propertyKey;
        if (!key) return null;
        const where = await whereOmit(mono(`prop.${key}`));
        const rows = await prisma.product.findMany({
          where,
          select: { properties: true },
          take: 20000,
        });
        const counts = new Map<string, number>();
        for (const r of rows) {
          const v = (r.properties as Record<string, unknown> | null)?.[key];
          if (typeof v === "string") counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const sel = new Set(f.props[key] ?? []);
        for (const s of sel) if (!counts.has(s)) counts.set(s, 0);
        const options = [...counts.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([value, count]) => ({ value, label: value, count, selected: sel.has(value) }))
          .filter((o) => o.count > 0 || o.selected);
        return nonEmpty({ ...base, key: `prop.${key}`, type: multi, options });
      }
    }
    return null;
  };

  const built = await Promise.all(groups.map(build));
  return {
    category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
    groups: built.filter((g): g is FilterGroupOut => g !== null),
  };
}

function nonEmpty(g: FilterGroupOut): FilterGroupOut | null {
  return g.options.length ? g : null;
}

/** Child categories of the current category (or roots) with counts that ignore the category facet. */
async function categoryOptions(
  prisma: PrismaClient,
  f: ParsedFilters,
  currentId: string | null,
  now: Date,
): Promise<FilterOption[]> {
  const all = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, parentId: true, name: true, slug: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const children = all.filter((c) => (currentId ? c.parentId === currentId : c.parentId === null));
  if (!children.length) return [];
  const scope: Prisma.ProductWhereInput = currentId
    ? { categoryId: { in: await categoryTreeIds(prisma, currentId) } }
    : {};
  const base = await buildProductWhere(prisma, f, { omit: new Set<FacetKey>(["category"]), now });
  const rows = await prisma.product.groupBy({
    by: ["categoryId"],
    where: { AND: [base, scope] },
    _count: { _all: true },
  });
  const byCat = new Map(rows.map((r) => [r.categoryId, r._count._all]));
  const kids = new Map<string, string[]>();
  for (const c of all)
    if (c.parentId) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c.id]);
  const total = (id: string): number =>
    (byCat.get(id) ?? 0) + (kids.get(id) ?? []).reduce((s, k) => s + total(k), 0);
  return children
    .map((c) => ({ value: c.slug, label: c.name, count: total(c.id), selected: false }))
    .filter((o) => o.count > 0);
}
