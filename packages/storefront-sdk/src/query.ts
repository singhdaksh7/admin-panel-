import type { ProductQuery } from "./types";

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type QueryParams = Record<string, QueryValue>;

/**
 * Serialise a flat params object. Arrays become comma-separated lists (the API grammar),
 * `undefined`/`null`/empty values are dropped, booleans become "true"/"false". Keys are sorted
 * so identical queries always produce identical URLs (cache friendly).
 */
export function toSearchParams(params: QueryParams | undefined): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const list = v.map(String).filter((s) => s !== "");
      if (list.length) sp.set(key, list.join(","));
    } else if (typeof v === "boolean") {
      sp.set(key, v ? "true" : "false");
    } else if (String(v) !== "") {
      sp.set(key, String(v));
    }
  }
  return sp.toString();
}

/** `ProductQuery` -> flat API params (`attr.<slug>`, `prop.<key>` expanded). */
export function productQueryParams(q: ProductQuery = {}): QueryParams {
  const out: QueryParams = {
    page: q.page,
    pageSize: q.pageSize,
    q: q.q,
    category: q.category,
    collection: q.collection,
    tag: q.tag,
    minPrice: q.minPrice,
    maxPrice: q.maxPrice,
    sort: q.sort,
  };
  if (q.inStock) out.inStock = true;
  for (const [slug, values] of Object.entries(q.attributes ?? {})) out[`attr.${slug}`] = values;
  for (const [key, values] of Object.entries(q.properties ?? {}))
    out[`prop.${key}`] = Array.isArray(values) ? values : [values];
  return out;
}

/** Inverse helper for storefront routing: parse `URLSearchParams` into a `ProductQuery`. */
export function parseProductQuery(search: string | URLSearchParams): ProductQuery {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const q: ProductQuery = {};
  const num = (k: string) => {
    const v = Number(sp.get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const page = num("page");
  const pageSize = num("pageSize");
  if (page) q.page = page;
  if (pageSize) q.pageSize = pageSize;
  for (const k of ["q", "category", "collection", "minPrice", "maxPrice"] as const) {
    const v = sp.get(k);
    if (v) (q as Record<string, unknown>)[k] = v;
  }
  const sort = sp.get("sort");
  if (sort) q.sort = sort as ProductQuery["sort"];
  const tag = sp.get("tag");
  if (tag) q.tag = tag.split(",");
  if (sp.get("inStock") === "true" || sp.get("inStock") === "1") q.inStock = true;
  for (const [k, v] of sp.entries()) {
    if (!v) continue;
    if (k.startsWith("attr.")) (q.attributes ??= {})[k.slice(5)] = v.split(",");
    else if (k.startsWith("prop.")) (q.properties ??= {})[k.slice(5)] = v.split(",");
  }
  return q;
}
