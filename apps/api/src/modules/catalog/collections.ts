import { Router } from "express";
import { z } from "zod";
import { AppError, clampPage, paginated } from "@kash-commerce/shared";
import { Prisma, type PrismaClient } from "@kash-commerce/database";
import type { AppContext } from "../../context";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { categoryTreeIds, publishedWhere } from "../../lib/productQuery";
import { missingMediaIds } from "../media/service";
import { isUniqueViolation, money, seoSchema, slugSchema, uniqueSlug } from "./common";

// ───────────── rules ─────────────

const asList = z.union([
  z.string().min(1).max(120),
  z.array(z.string().min(1).max(120)).min(1).max(50),
]);

export const ruleCondition = z.discriminatedUnion("field", [
  z.object({ field: z.literal("category"), value: asList }), // category slug(s), includes descendants
  z.object({ field: z.literal("tag"), value: asList }), // tag slug(s), any-of
  z.object({ field: z.literal("brand"), value: asList }),
  z.object({ field: z.literal("featured"), value: z.boolean() }),
  z.object({ field: z.literal("price"), op: z.enum(["gte", "lte", "eq"]), value: money }),
  z.object({ field: z.literal("attribute"), attribute: z.string().min(1).max(120), value: asList }),
]);
export const rulesSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(ruleCondition).min(1).max(20),
});
export type CollectionRules = z.infer<typeof rulesSchema>;

const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

/**
 * Translate a RULE collection's rules into a Prisma product where (without the published filter).
 * Supported conditions: category (tree), tag, brand, featured, price (gte/lte/eq on active variants),
 * attribute (attribute slug + value slugs, variant or product level).
 */
export async function ruleWhere(
  prisma: PrismaClient,
  rules: CollectionRules,
): Promise<Prisma.ProductWhereInput> {
  const parts: Prisma.ProductWhereInput[] = [];
  for (const c of rules.conditions) {
    switch (c.field) {
      case "category": {
        const cats = await prisma.category.findMany({
          where: { slug: { in: list(c.value) } },
          select: { id: true },
        });
        const ids = (await Promise.all(cats.map((x) => categoryTreeIds(prisma, x.id)))).flat();
        parts.push({ categoryId: { in: ids.length ? ids : ["__none__"] } });
        break;
      }
      case "tag":
        parts.push({ tags: { some: { tag: { slug: { in: list(c.value) } } } } });
        break;
      case "brand":
        parts.push({ brand: { in: list(c.value), mode: "insensitive" } });
        break;
      case "featured":
        parts.push({ isFeatured: c.value });
        break;
      case "price":
        parts.push({
          variants: {
            some: {
              isActive: true,
              price: c.op === "eq" ? c.value : { [c.op]: c.value },
            },
          },
        });
        break;
      case "attribute": {
        const match = {
          attributeValue: { slug: { in: list(c.value) }, attribute: { slug: c.attribute } },
        };
        parts.push({
          OR: [
            { attributeValues: { some: match } },
            { variants: { some: { isActive: true, attributes: { some: match } } } },
          ],
        });
        break;
      }
    }
  }
  return rules.match === "any" ? { OR: parts } : { AND: parts };
}

/** Full where for a collection's storefront membership (published only). */
export async function collectionProductWhere(
  prisma: PrismaClient,
  c: { id: string; type: "MANUAL" | "RULE"; rules: unknown },
): Promise<Prisma.ProductWhereInput> {
  if (c.type === "RULE") {
    const parsed = rulesSchema.safeParse(c.rules);
    if (!parsed.success) return { id: "__none__" };
    return { AND: [publishedWhere(), await ruleWhere(prisma, parsed.data)] };
  }
  return { AND: [publishedWhere(), { collections: { some: { collectionId: c.id } } }] };
}

// ───────────── routes ─────────────

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  description: z.string().max(5000).nullable().optional(),
  type: z.enum(["MANUAL", "RULE"]).optional(),
  rules: rulesSchema.nullable().optional(),
  imageMediaId: z.string().min(1).max(64).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  seo: seoSchema.nullable().optional(),
});
const productIds = z.object({ productIds: z.array(z.string().min(1).max(64)).min(1).max(500) });
const collectionProductParam = z.object({
  id: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
});

export function registerCollections(ctx: AppContext, admin: Router) {
  const p = ctx.prisma;
  const slugTaken = async (s: string) =>
    !!(await p.collection.findUnique({ where: { slug: s }, select: { id: true } }));

  const loadOr404 = async (id: string) => {
    const c = await p.collection.findUnique({ where: { id } });
    if (!c) throw AppError.notFound("Collection");
    return c;
  };

  admin.get(
    "/collections",
    requirePermission("products.read"),
    h(async (_req, res) => {
      const rows = await p.collection.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: { _count: { select: { products: true } } },
      });
      res.json({
        items: rows.map(({ _count, ...c }) => ({ ...c, manualProductCount: _count.products })),
      });
    }),
  );

  admin.get(
    "/collections/:id",
    requirePermission("products.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json(await loadOr404(id));
    }),
  );

  admin.post(
    "/collections",
    requirePermission("collections.write"),
    h(async (req, res) => {
      const body = parse(createBody, req.body);
      const type = body.type ?? "MANUAL";
      if (type === "RULE" && !body.rules) throw AppError.validation("RULE collections need rules");
      if (type === "MANUAL" && body.rules)
        throw AppError.validation("MANUAL collections cannot have rules");
      if (body.imageMediaId && (await missingMediaIds(p, [body.imageMediaId])).length)
        throw AppError.validation("Unknown media id");
      if (body.slug && (await slugTaken(body.slug))) throw AppError.conflict("Slug already in use");
      const slug = body.slug ?? (await uniqueSlug(slugTaken, body.name));
      try {
        const c = await p.collection.create({
          data: {
            name: body.name,
            slug,
            description: body.description ?? null,
            type,
            rules: (body.rules ?? undefined) as Prisma.InputJsonValue | undefined,
            imageMediaId: body.imageMediaId ?? null,
            sortOrder: body.sortOrder ?? 0,
            isActive: body.isActive ?? true,
            seo: (body.seo ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });
        await audit(ctx, req, {
          action: "collection.create",
          entityType: "Collection",
          entityId: c.id,
          after: { name: c.name, slug, type },
        });
        res.status(201).json(c);
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("Slug already in use");
        throw err;
      }
    }),
  );

  admin.patch(
    "/collections/:id",
    requirePermission("collections.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(createBody.partial(), req.body);
      const before = await loadOr404(id);
      const type = body.type ?? before.type;
      const rules = body.rules !== undefined ? body.rules : before.rules;
      if (type === "RULE" && !rules) throw AppError.validation("RULE collections need rules");
      if (body.imageMediaId && (await missingMediaIds(p, [body.imageMediaId])).length)
        throw AppError.validation("Unknown media id");
      if (body.slug && body.slug !== before.slug && (await slugTaken(body.slug)))
        throw AppError.conflict("Slug already in use");
      const c = await p.collection.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.rules !== undefined || body.type === "MANUAL"
            ? {
                rules: type === "RULE" && rules ? (rules as Prisma.InputJsonValue) : Prisma.DbNull,
              }
            : {}),
          ...(body.imageMediaId !== undefined ? { imageMediaId: body.imageMediaId } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.seo !== undefined
            ? { seo: (body.seo ?? Prisma.DbNull) as Prisma.InputJsonValue }
            : {}),
        },
      });
      await audit(ctx, req, {
        action: "collection.update",
        entityType: "Collection",
        entityId: id,
        before,
        after: body,
      });
      res.json(c);
    }),
  );

  admin.delete(
    "/collections/:id",
    requirePermission("collections.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const c = await loadOr404(id);
      await p.collection.delete({ where: { id } });
      await audit(ctx, req, {
        action: "collection.delete",
        entityType: "Collection",
        entityId: id,
        before: { name: c.name },
      });
      res.status(204).end();
    }),
  );

  // Members (manual: stored; rule: evaluated). Includes drafts - this is the admin view.
  admin.get(
    "/collections/:id/products",
    requirePermission("products.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const c = await loadOr404(id);
      const pg = clampPage(req.query.page, req.query.pageSize);
      const select = { id: true, title: true, slug: true, status: true } as const;
      if (c.type === "RULE") {
        const rules = rulesSchema.safeParse(c.rules);
        const where = rules.success ? await ruleWhere(p, rules.data) : { id: "__none__" };
        const [items, total] = await Promise.all([
          p.product.findMany({
            where,
            select,
            orderBy: { createdAt: "desc" },
            skip: (pg.page - 1) * pg.pageSize,
            take: pg.pageSize,
          }),
          p.product.count({ where }),
        ]);
        res.json(paginated(items, total, pg));
        return;
      }
      const where = { collectionId: id };
      const [rows, total] = await Promise.all([
        p.collectionProduct.findMany({
          where,
          orderBy: [{ position: "asc" }, { productId: "asc" }],
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
          include: { product: { select } },
        }),
        p.collectionProduct.count({ where }),
      ]);
      res.json(
        paginated(
          rows.map((r) => ({ ...r.product, position: r.position })),
          total,
          pg,
        ),
      );
    }),
  );

  admin.post(
    "/collections/:id/products",
    requirePermission("collections.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(productIds, req.body);
      const c = await loadOr404(id);
      if (c.type !== "MANUAL")
        throw AppError.conflict("Products of a RULE collection are computed from its rules");
      const ids = [...new Set(body.productIds)];
      const found = await p.product.findMany({ where: { id: { in: ids } }, select: { id: true } });
      if (found.length !== ids.length) throw AppError.validation("Unknown product id");
      const max = await p.collectionProduct.aggregate({
        where: { collectionId: id },
        _max: { position: true },
      });
      const start = (max._max.position ?? -1) + 1;
      await p.collectionProduct.createMany({
        data: ids.map((productId, i) => ({ collectionId: id, productId, position: start + i })),
        skipDuplicates: true,
      });
      await audit(ctx, req, {
        action: "collection.products.add",
        entityType: "Collection",
        entityId: id,
        extra: { count: ids.length },
      });
      res.status(201).json({ added: ids.length });
    }),
  );

  admin.put(
    "/collections/:id/products/order",
    requirePermission("collections.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(productIds, req.body);
      await loadOr404(id);
      const members = await p.collectionProduct.findMany({
        where: { collectionId: id },
        select: { productId: true },
      });
      const have = new Set(members.map((m) => m.productId));
      if (body.productIds.some((x) => !have.has(x)))
        throw AppError.validation("Order contains products that are not in the collection");
      await p.$transaction(
        body.productIds.map((productId, position) =>
          p.collectionProduct.update({
            where: { collectionId_productId: { collectionId: id, productId } },
            data: { position },
          }),
        ),
      );
      await audit(ctx, req, {
        action: "collection.products.reorder",
        entityType: "Collection",
        entityId: id,
      });
      res.json({ ok: true });
    }),
  );

  admin.delete(
    "/collections/:id/products/:productId",
    requirePermission("collections.write"),
    h(async (req, res) => {
      const { id, productId } = parse(collectionProductParam, req.params);
      const r = await p.collectionProduct.deleteMany({ where: { collectionId: id, productId } });
      if (!r.count) throw AppError.notFound("Collection product");
      await audit(ctx, req, {
        action: "collection.products.remove",
        entityType: "Collection",
        entityId: id,
        extra: { productId },
      });
      res.status(204).end();
    }),
  );
}
