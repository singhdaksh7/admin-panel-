import { Router } from "express";
import { AppError, clampPage, paginated } from "@kash-commerce/shared";
import type { Prisma } from "@kash-commerce/database";
import type { AppContext } from "../../context";
import { h } from "../../lib/http";
import { createLimiters } from "../../lib/rateLimits";
import { buildProductWhere, parseFilters, publishedWhere } from "../../lib/productQuery";
import { collectionProductWhere } from "./collections";
import {
  listPublicProducts,
  listSelect,
  parseSort,
  presentImage,
  presentListItem,
  presentPage,
  ratingsFor,
  storeCurrency,
  variantAvailability,
  type ListRow,
} from "./present";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const slugParam = (v: unknown): string => {
  const s = String(v ?? "");
  if (!SLUG_RE.test(s) || s.length > 150) throw AppError.notFound("Resource");
  return s;
};

export function registerPublic(ctx: AppContext): Router {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const r = Router();
  const read = limiters.publicRead;

  // ───── products ─────
  r.get(
    "/products",
    read,
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize);
      const where = await buildProductWhere(p, parseFilters(req.query));
      res.json(await listPublicProducts(ctx, where, parseSort(req.query.sort), pg));
    }),
  );

  r.get(
    "/products/search",
    read,
    h(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q) throw AppError.badRequest("Query parameter q is required");
      const pg = clampPage(req.query.page, req.query.pageSize);
      const where = await buildProductWhere(p, parseFilters(req.query));
      res.json(await listPublicProducts(ctx, where, parseSort(req.query.sort), pg));
    }),
  );

  const detailSelect = {
    ...listSelect,
    description: true,
    brand: true,
    seo: true,
    properties: true,
    categoryId: true,
    tags: { select: { tag: { select: { name: true, slug: true } } } },
    attributeValues: {
      select: {
        attributeValue: {
          select: {
            value: true,
            slug: true,
            meta: true,
            sortOrder: true,
            attribute: { select: { name: true, slug: true, sortOrder: true } },
          },
        },
      },
    },
    variants: {
      where: { isActive: true },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        sku: true,
        title: true,
        price: true,
        compareAtPrice: true,
        weightGrams: true,
        imageMediaId: true,
        isDefault: true,
        inventory: {
          select: { onHand: true, reserved: true, trackInventory: true, allowBackorder: true },
        },
        attributes: {
          select: {
            attributeValue: {
              select: {
                value: true,
                slug: true,
                sortOrder: true,
                attribute: { select: { name: true, slug: true, sortOrder: true } },
              },
            },
          },
        },
      },
    },
  } satisfies Prisma.ProductSelect;

  r.get(
    "/products/:slug",
    read,
    h(async (req, res) => {
      const slug = slugParam(req.params.slug);
      const prod = await p.product.findFirst({
        where: { AND: [publishedWhere(), { slug }, { variants: { some: { isActive: true } } }] },
        select: detailSelect,
      });
      if (!prod) throw AppError.notFound("Product");

      const variantMediaIds = [
        ...new Set(prod.variants.map((v) => v.imageMediaId).filter((x): x is string => !!x)),
      ];
      const [currency, ratings, variantMedia, related] = await Promise.all([
        storeCurrency(ctx),
        ratingsFor(ctx, [prod.id]),
        variantMediaIds.length
          ? p.media.findMany({
              where: { id: { in: variantMediaIds } },
              select: { id: true, storageKey: true, altText: true, width: true, height: true },
            })
          : Promise.resolve([]),
        prod.categoryId
          ? listPublicProducts(
              ctx,
              { AND: [publishedWhere(), { categoryId: prod.categoryId, id: { not: prod.id } }] },
              "featured",
              { page: 1, pageSize: 8 },
            )
          : Promise.resolve(null),
      ]);
      const mediaById = new Map(variantMedia.map((m) => [m.id, m]));
      const base = presentListItem(ctx, prod as unknown as ListRow, currency, ratings.get(prod.id));

      const groups = new Map<
        string,
        {
          attribute: string;
          attributeSlug: string;
          sort: number;
          values: Map<string, { value: string; slug: string; sort: number }>;
        }
      >();
      for (const v of prod.variants)
        for (const a of v.attributes) {
          const at = a.attributeValue.attribute;
          const g = groups.get(at.slug) ?? {
            attribute: at.name,
            attributeSlug: at.slug,
            sort: at.sortOrder,
            values: new Map(),
          };
          g.values.set(a.attributeValue.slug, {
            value: a.attributeValue.value,
            slug: a.attributeValue.slug,
            sort: a.attributeValue.sortOrder,
          });
          groups.set(at.slug, g);
        }

      res.json({
        ...base,
        description: prod.description,
        brand: prod.brand,
        seo: prod.seo,
        properties: prod.properties,
        tags: prod.tags.map((t) => t.tag),
        attributes: prod.attributeValues
          .map((a) => a.attributeValue)
          .sort(
            (a, b) => a.attribute.sortOrder - b.attribute.sortOrder || a.sortOrder - b.sortOrder,
          )
          .map((a) => ({
            attribute: a.attribute.name,
            attributeSlug: a.attribute.slug,
            value: a.value,
            valueSlug: a.slug,
          })),
        options: [...groups.values()]
          .sort((a, b) => a.sort - b.sort)
          .map((g) => ({
            attribute: g.attribute,
            attributeSlug: g.attributeSlug,
            values: [...g.values.values()]
              .sort((a, b) => a.sort - b.sort)
              .map(({ value, slug: s }) => ({ value, slug: s })),
          })),
        variants: prod.variants.map((v) => {
          const av = variantAvailability(v.inventory);
          const media = v.imageMediaId ? mediaById.get(v.imageMediaId) : undefined;
          return {
            id: v.id,
            sku: v.sku,
            title: v.title,
            price: v.price.toFixed(2),
            compareAtPrice:
              v.compareAtPrice && v.compareAtPrice.gt(v.price) ? v.compareAtPrice.toFixed(2) : null,
            weightGrams: v.weightGrams,
            isDefault: v.isDefault,
            attributes: v.attributes.map((a) => ({
              attribute: a.attributeValue.attribute.name,
              attributeSlug: a.attributeValue.attribute.slug,
              value: a.attributeValue.value,
              valueSlug: a.attributeValue.slug,
            })),
            inStock: av.inStock,
            available: av.available,
            image: media ? presentImage(ctx, media).url : null,
          };
        }),
        related: related?.items ?? [],
      });
    }),
  );

  // ───── categories ─────
  r.get(
    "/categories",
    read,
    h(async (req, res) => {
      const rows = await p.category.findMany({
        where: { isActive: true },
        select: {
          id: true,
          parentId: true,
          name: true,
          slug: true,
          description: true,
          imageMediaId: true,
          sortOrder: true,
        },
      });
      const mediaIds = [
        ...new Set(rows.map((c) => c.imageMediaId).filter((x): x is string => !!x)),
      ];
      const media = mediaIds.length
        ? await p.media.findMany({
            where: { id: { in: mediaIds } },
            select: { id: true, storageKey: true },
          })
        : [];
      const mediaUrl = new Map(media.map((m) => [m.id, ctx.providers.storage.url(m.storageKey)]));

      const withCounts = req.query.productCount === "true" || req.query.counts === "true";
      const direct = new Map<string, number>();
      if (withCounts) {
        const g = await p.product.groupBy({
          by: ["categoryId"],
          where: publishedWhere(),
          _count: { _all: true },
        });
        for (const x of g) if (x.categoryId) direct.set(x.categoryId, x._count._all);
      }

      interface Node {
        id: string;
        name: string;
        slug: string;
        description: string | null;
        image: string | null;
        sortOrder: number;
        productCount?: number;
        children: Node[];
      }
      const nodes = new Map<string, Node>();
      for (const c of rows)
        nodes.set(c.id, {
          id: c.id,
          name: c.name,
          slug: c.slug,
          description: c.description,
          image: c.imageMediaId ? (mediaUrl.get(c.imageMediaId) ?? null) : null,
          sortOrder: c.sortOrder,
          children: [],
        });
      const roots: Node[] = [];
      for (const c of rows) {
        const n = nodes.get(c.id)!;
        const parent = c.parentId ? nodes.get(c.parentId) : undefined;
        // children of an inactive parent are unreachable => dropped
        if (parent) parent.children.push(n);
        else if (!c.parentId) roots.push(n);
      }
      const finish = (list: Node[]): number => {
        list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        let sum = 0;
        for (const n of list) {
          const sub = finish(n.children);
          if (withCounts) {
            n.productCount = (direct.get(n.id) ?? 0) + sub;
            sum += n.productCount;
          }
        }
        return sum;
      };
      finish(roots);
      res.json({ items: roots });
    }),
  );

  r.get(
    "/categories/:slug",
    read,
    h(async (req, res) => {
      const slug = slugParam(req.params.slug);
      const all = await p.category.findMany({
        select: {
          id: true,
          parentId: true,
          name: true,
          slug: true,
          description: true,
          imageMediaId: true,
          bannerMediaId: true,
          sortOrder: true,
          isActive: true,
          seo: true,
        },
      });
      const byId = new Map(all.map((c) => [c.id, c]));
      const cat = all.find((c) => c.slug === slug);
      if (!cat || !cat.isActive) throw AppError.notFound("Category");
      const chain: typeof all = [];
      for (
        let cur: (typeof all)[number] | undefined = cat;
        cur;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      ) {
        if (!cur.isActive) throw AppError.notFound("Category");
        chain.unshift(cur);
        if (chain.length > 50) break;
      }
      const mids = [
        cat.imageMediaId,
        cat.bannerMediaId,
        ...all.filter((c) => c.parentId === cat.id).map((c) => c.imageMediaId),
      ].filter((x): x is string => !!x);
      const media = mids.length
        ? await p.media.findMany({
            where: { id: { in: mids } },
            select: { id: true, storageKey: true },
          })
        : [];
      const url = (id: string | null) => {
        const m = media.find((x) => x.id === id);
        return m ? ctx.providers.storage.url(m.storageKey) : null;
      };
      res.json({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        image: url(cat.imageMediaId),
        banner: url(cat.bannerMediaId),
        seo: cat.seo,
        breadcrumb: chain.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
        children: all
          .filter((c) => c.parentId === cat.id && c.isActive)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
          .map((c) => ({ id: c.id, name: c.name, slug: c.slug, image: url(c.imageMediaId) })),
      });
    }),
  );

  // ───── collections ─────
  r.get(
    "/collections",
    read,
    h(async (_req, res) => {
      const rows = await p.collection.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, slug: true, description: true, imageMediaId: true },
      });
      const mids = rows.map((c) => c.imageMediaId).filter((x): x is string => !!x);
      const media = mids.length
        ? await p.media.findMany({
            where: { id: { in: mids } },
            select: { id: true, storageKey: true },
          })
        : [];
      res.json({
        items: rows.map((c) => {
          const m = media.find((x) => x.id === c.imageMediaId);
          return {
            id: c.id,
            name: c.name,
            slug: c.slug,
            description: c.description,
            image: m ? ctx.providers.storage.url(m.storageKey) : null,
          };
        }),
      });
    }),
  );

  r.get(
    "/collections/:slug",
    read,
    h(async (req, res) => {
      const slug = slugParam(req.params.slug);
      const c = await p.collection.findFirst({ where: { slug, isActive: true } });
      if (!c) throw AppError.notFound("Collection");
      const pg = clampPage(req.query.page, req.query.pageSize);
      const where = await collectionProductWhere(p, c);
      const sortGiven = typeof req.query.sort === "string";
      let products;
      if (c.type === "MANUAL" && !sortGiven) {
        const full: Prisma.ProductWhereInput = {
          AND: [where, { variants: { some: { isActive: true } } }],
        };
        const members = await p.collectionProduct.findMany({
          where: { collectionId: c.id, product: full },
          orderBy: [{ position: "asc" }, { productId: "asc" }],
          select: { productId: true },
        });
        const ids = members
          .slice((pg.page - 1) * pg.pageSize, pg.page * pg.pageSize)
          .map((m) => m.productId);
        const found = await p.product.findMany({ where: { id: { in: ids } }, select: listSelect });
        const byId = new Map(found.map((f) => [f.id, f]));
        products = await presentPage(
          ctx,
          ids.map((i) => byId.get(i)).filter((x): x is ListRow => !!x),
          members.length,
          pg,
        );
      } else {
        products = await listPublicProducts(ctx, where, parseSort(req.query.sort), pg);
      }
      let image: string | null = null;
      if (c.imageMediaId) {
        const m = await p.media.findUnique({
          where: { id: c.imageMediaId },
          select: { storageKey: true },
        });
        if (m) image = ctx.providers.storage.url(m.storageKey);
      }
      res.json({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        image,
        seo: c.seo,
        products: paginated(products.items, products.total, pg),
      });
    }),
  );

  return r;
}
