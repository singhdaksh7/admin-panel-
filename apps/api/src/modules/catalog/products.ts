import crypto from "node:crypto";
import { Router } from "express";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { AppError, clampPage, paginated, slugify } from "@kash-commerce/shared";
import { Prisma, type PrismaClient } from "@kash-commerce/database";
import type { AppContext } from "../../context";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { missingMediaIds } from "../media/service";
import { availableQuantity } from "../inventory/service";
import {
  dec,
  isFkViolation,
  isUniqueViolation,
  isoDate,
  money,
  sanitizeRich,
  seoSchema,
  slugSchema,
  str,
  uniqueSlug,
} from "./common";

type Tx = Prisma.TransactionClient;

// ───────────── schemas ─────────────

const intField = (max: number) => z.number().int().min(0).max(max);
const idList = (max = 100) => z.array(z.string().min(1).max(64)).max(max);

const variantFields = {
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, "SKU may contain letters, digits and . _ - /"),
  barcode: z.string().trim().max(64).nullable(),
  title: z.string().trim().max(200).nullable(),
  price: money,
  compareAtPrice: money.nullable(),
  cost: money.nullable(),
  weightGrams: intField(100_000_000).nullable(),
  lengthMm: intField(100_000).nullable(),
  widthMm: intField(100_000).nullable(),
  heightMm: intField(100_000).nullable(),
  imageMediaId: z.string().min(1).max(64).nullable(),
  isActive: z.boolean(),
  enabled: z.boolean(), // alias of isActive
  position: z.number().int().min(0).max(100_000),
  attributeValueIds: idList(10),
  stock: intField(10_000_000),
  lowStockThreshold: intField(1_000_000),
  trackInventory: z.boolean(),
  allowBackorder: z.boolean(),
};

const variantCreate = z.object({
  ...variantFields,
  sku: variantFields.sku,
  price: variantFields.price,
  barcode: variantFields.barcode.optional(),
  title: variantFields.title.optional(),
  compareAtPrice: variantFields.compareAtPrice.optional(),
  cost: variantFields.cost.optional(),
  weightGrams: variantFields.weightGrams.optional(),
  lengthMm: variantFields.lengthMm.optional(),
  widthMm: variantFields.widthMm.optional(),
  heightMm: variantFields.heightMm.optional(),
  imageMediaId: variantFields.imageMediaId.optional(),
  isActive: variantFields.isActive.optional(),
  enabled: variantFields.enabled.optional(),
  position: variantFields.position.optional(),
  attributeValueIds: variantFields.attributeValueIds.optional(),
  stock: variantFields.stock.optional(),
  lowStockThreshold: variantFields.lowStockThreshold.optional(),
  trackInventory: variantFields.trackInventory.optional(),
  allowBackorder: variantFields.allowBackorder.optional(),
});
type VariantCreate = z.infer<typeof variantCreate>;

const variantUpdate = z.object({
  sku: variantFields.sku.optional(),
  barcode: variantFields.barcode.optional(),
  title: variantFields.title.optional(),
  price: variantFields.price.optional(),
  compareAtPrice: variantFields.compareAtPrice.optional(),
  cost: variantFields.cost.optional(),
  weightGrams: variantFields.weightGrams.optional(),
  lengthMm: variantFields.lengthMm.optional(),
  widthMm: variantFields.widthMm.optional(),
  heightMm: variantFields.heightMm.optional(),
  imageMediaId: variantFields.imageMediaId.optional(),
  isActive: variantFields.isActive.optional(),
  enabled: variantFields.enabled.optional(),
  position: variantFields.position.optional(),
  attributeValueIds: variantFields.attributeValueIds.optional(),
});

const productFields = {
  title: z.string().trim().min(1).max(250),
  slug: slugSchema,
  shortDescription: z.string().max(1000).nullable(),
  description: z.string().max(100_000).nullable(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
  categoryId: z.string().min(1).max(64).nullable(),
  taxClassId: z.string().min(1).max(64).nullable(),
  brand: z.string().trim().max(120).nullable(),
  isFeatured: z.boolean(),
  isNew: z.boolean(),
  publishAt: isoDate.nullable(),
  unpublishAt: isoDate.nullable(),
  seo: seoSchema.nullable(),
  properties: z.record(z.unknown()).nullable(),
  imageMediaIds: idList(50),
  attributeValueIds: idList(100),
  tags: z.array(z.string().trim().min(1).max(60)).max(50),
  collectionIds: idList(50),
};

// Simple-product shortcut fields (create): become the single default variant.
const simpleFields = {
  price: variantFields.price.optional(),
  compareAtPrice: variantFields.compareAtPrice.optional(),
  cost: variantFields.cost.optional(),
  sku: variantFields.sku.optional(),
  barcode: variantFields.barcode.optional(),
  weightGrams: variantFields.weightGrams.optional(),
  lengthMm: variantFields.lengthMm.optional(),
  widthMm: variantFields.widthMm.optional(),
  heightMm: variantFields.heightMm.optional(),
  stock: variantFields.stock.optional(),
  lowStockThreshold: variantFields.lowStockThreshold.optional(),
  trackInventory: variantFields.trackInventory.optional(),
  allowBackorder: variantFields.allowBackorder.optional(),
};

const createProduct = z.object({
  title: productFields.title,
  slug: productFields.slug.optional(),
  shortDescription: productFields.shortDescription.optional(),
  description: productFields.description.optional(),
  status: productFields.status.optional(),
  categoryId: productFields.categoryId.optional(),
  taxClassId: productFields.taxClassId.optional(),
  brand: productFields.brand.optional(),
  isFeatured: productFields.isFeatured.optional(),
  isNew: productFields.isNew.optional(),
  publishAt: productFields.publishAt.optional(),
  unpublishAt: productFields.unpublishAt.optional(),
  seo: productFields.seo.optional(),
  properties: productFields.properties.optional(),
  imageMediaIds: productFields.imageMediaIds.optional(),
  attributeValueIds: productFields.attributeValueIds.optional(),
  tags: productFields.tags.optional(),
  collectionIds: productFields.collectionIds.optional(),
  variants: z.array(variantCreate).min(1).max(300).optional(),
  ...simpleFields,
});

const updateProduct = z.object({
  title: productFields.title.optional(),
  slug: productFields.slug.optional(),
  shortDescription: productFields.shortDescription.optional(),
  description: productFields.description.optional(),
  status: productFields.status.optional(),
  categoryId: productFields.categoryId.optional(),
  taxClassId: productFields.taxClassId.optional(),
  brand: productFields.brand.optional(),
  isFeatured: productFields.isFeatured.optional(),
  isNew: productFields.isNew.optional(),
  publishAt: productFields.publishAt.optional(),
  unpublishAt: productFields.unpublishAt.optional(),
  seo: productFields.seo.optional(),
  properties: productFields.properties.optional(),
  imageMediaIds: productFields.imageMediaIds.optional(),
  attributeValueIds: productFields.attributeValueIds.optional(),
  tags: productFields.tags.optional(),
  collectionIds: productFields.collectionIds.optional(),
  // only for single-variant products
  price: simpleFields.price,
  compareAtPrice: simpleFields.compareAtPrice,
  cost: simpleFields.cost,
  sku: simpleFields.sku,
  barcode: simpleFields.barcode,
});

const bulkStatus = z.object({
  ids: idList(200).min(1),
  status: productFields.status,
});

const variantParams = z.object({
  id: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64),
});

// ───────────── includes / presenters ─────────────

const fullInclude = {
  category: { select: { id: true, name: true, slug: true } },
  taxClass: true,
  images: { orderBy: { position: "asc" }, include: { media: true } },
  attributeValues: { include: { attributeValue: { include: { attribute: true } } } },
  tags: { include: { tag: true } },
  collections: { include: { collection: { select: { id: true, name: true, slug: true } } } },
  variants: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: {
      attributes: { include: { attributeValue: { include: { attribute: true } } } },
      inventory: true,
    },
  },
} satisfies Prisma.ProductInclude;

type FullProduct = Prisma.ProductGetPayload<{ include: typeof fullInclude }>;
type FullVariant = FullProduct["variants"][number];

function visibility(p: { status: string; publishAt: Date | null; unpublishAt: Date | null }) {
  const now = new Date();
  if (p.status !== "ACTIVE") return "hidden";
  if (p.publishAt && p.publishAt > now) return "scheduled";
  if (p.unpublishAt && p.unpublishAt <= now) return "expired";
  return "live";
}

function presentVariant(ctx: AppContext, v: FullVariant) {
  const inv = v.inventory;
  return {
    id: v.id,
    productId: v.productId,
    sku: v.sku,
    barcode: v.barcode,
    title: v.title,
    price: v.price.toFixed(2),
    compareAtPrice: str(v.compareAtPrice),
    cost: str(v.cost),
    weightGrams: v.weightGrams,
    lengthMm: v.lengthMm,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
    imageMediaId: v.imageMediaId,
    isDefault: v.isDefault,
    isActive: v.isActive,
    position: v.position,
    attributes: v.attributes.map((a) => ({
      attributeId: a.attributeValue.attributeId,
      attribute: a.attributeValue.attribute.name,
      attributeSlug: a.attributeValue.attribute.slug,
      valueId: a.attributeValueId,
      value: a.attributeValue.value,
      valueSlug: a.attributeValue.slug,
    })),
    inventory: inv
      ? {
          onHand: inv.onHand,
          reserved: inv.reserved,
          available: availableQuantity(inv),
          lowStockThreshold: inv.lowStockThreshold,
          trackInventory: inv.trackInventory,
          allowBackorder: inv.allowBackorder,
        }
      : null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function presentProduct(ctx: AppContext, p: FullProduct) {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    shortDescription: p.shortDescription,
    description: p.description,
    status: p.status,
    visibility: visibility(p),
    category: p.category,
    categoryId: p.categoryId,
    taxClassId: p.taxClassId,
    taxClass: p.taxClass ? { ...p.taxClass, rate: p.taxClass.rate.toString() } : null,
    brand: p.brand,
    isFeatured: p.isFeatured,
    isNew: p.isNew,
    publishAt: p.publishAt,
    unpublishAt: p.unpublishAt,
    seo: p.seo,
    properties: p.properties,
    images: p.images.map((i) => ({
      id: i.id,
      mediaId: i.mediaId,
      position: i.position,
      url: ctx.providers.storage.url(i.media.storageKey),
      altText: i.media.altText,
    })),
    attributeValues: p.attributeValues.map((a) => ({
      attributeId: a.attributeValue.attributeId,
      attribute: a.attributeValue.attribute.name,
      attributeSlug: a.attributeValue.attribute.slug,
      valueId: a.attributeValueId,
      value: a.attributeValue.value,
      valueSlug: a.attributeValue.slug,
    })),
    tags: p.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })),
    collections: p.collections.map((c) => c.collection),
    variants: p.variants.map((v) => presentVariant(ctx, v)),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ───────────── helpers ─────────────

const plain = (s: string) => sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} }).trim();

const comboKey = (ids: string[]) => [...ids].sort().join("|");

function randomSku() {
  return `SKU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function assertValueIds(prisma: PrismaClient | Tx, ids: string[], variantLevel: boolean) {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw AppError.validation("Duplicate attribute value ids");
  if (!unique.length) return;
  const rows = await prisma.attributeValue.findMany({
    where: { id: { in: unique } },
    select: { id: true, attributeId: true },
  });
  if (rows.length !== unique.length) throw AppError.validation("Unknown attribute value id");
  if (variantLevel) {
    const attrs = new Set(rows.map((r) => r.attributeId));
    if (attrs.size !== rows.length)
      throw AppError.validation("A variant can have only one value per attribute");
  }
}

function checkPrices(price?: string, compareAt?: string | null) {
  if (price !== undefined && compareAt != null && Number(compareAt) < Number(price))
    throw AppError.validation("compareAtPrice must be greater than or equal to price");
}

function checkSchedule(publishAt?: Date | null, unpublishAt?: Date | null) {
  if (publishAt && unpublishAt && unpublishAt <= publishAt)
    throw AppError.validation("unpublishAt must be after publishAt");
}

async function resolveTags(tx: Tx, names: string[]): Promise<string[]> {
  const bySlug = new Map<string, string>();
  for (const n of names) {
    const slug = slugify(n);
    if (!bySlug.has(slug)) bySlug.set(slug, n);
  }
  const ids: string[] = [];
  for (const [slug, name] of bySlug) {
    const t = await tx.tag.upsert({ where: { slug }, create: { name, slug }, update: {} });
    ids.push(t.id);
  }
  return ids;
}

export function registerProducts(ctx: AppContext, admin: Router) {
  const p = ctx.prisma;

  const slugTaken = async (s: string) =>
    !!(await p.product.findUnique({ where: { slug: s }, select: { id: true } }));

  async function loadFull(id: string) {
    return p.product.findUnique({ where: { id }, include: fullInclude });
  }
  async function loadFullOr404(id: string) {
    const prod = await loadFull(id);
    if (!prod) throw AppError.notFound("Product");
    return prod;
  }

  async function assertRefs(body: {
    categoryId?: string | null;
    taxClassId?: string | null;
    imageMediaIds?: string[];
    collectionIds?: string[];
    attributeValueIds?: string[];
  }) {
    if (
      body.categoryId &&
      !(await p.category.findUnique({ where: { id: body.categoryId }, select: { id: true } }))
    )
      throw AppError.validation("Unknown category");
    if (
      body.taxClassId &&
      !(await p.taxClass.findUnique({ where: { id: body.taxClassId }, select: { id: true } }))
    )
      throw AppError.validation("Unknown tax class");
    if (body.imageMediaIds) {
      if (new Set(body.imageMediaIds).size !== body.imageMediaIds.length)
        throw AppError.validation("Duplicate image");
      const missing = await missingMediaIds(p, body.imageMediaIds);
      if (missing.length) throw AppError.validation("Unknown media id", { missing });
    }
    if (body.collectionIds?.length) {
      const found = await p.collection.findMany({
        where: { id: { in: body.collectionIds }, type: "MANUAL" },
        select: { id: true },
      });
      if (found.length !== new Set(body.collectionIds).size)
        throw AppError.validation("Unknown or non-manual collection id");
    }
    if (body.attributeValueIds) await assertValueIds(p, body.attributeValueIds, false);
  }

  async function assertSkusFree(skus: string[], exceptVariantIds: string[] = []) {
    if (new Set(skus).size !== skus.length) throw AppError.conflict("Duplicate SKU in request");
    const taken = await p.productVariant.findMany({
      where: { sku: { in: skus }, id: { notIn: exceptVariantIds } },
      select: { sku: true },
    });
    if (taken.length)
      throw AppError.conflict("SKU already in use", { skus: taken.map((t) => t.sku) });
  }

  /** Create a variant + attribute links + inventory (+ initial stock movement). */
  async function createVariant(
    tx: Tx,
    productId: string,
    v: VariantCreate,
    position: number,
    isDefault: boolean,
    actorId: string | null,
  ) {
    const created = await tx.productVariant.create({
      data: {
        productId,
        sku: v.sku,
        barcode: v.barcode ?? null,
        title: v.title ?? null,
        price: new Prisma.Decimal(v.price),
        compareAtPrice: dec(v.compareAtPrice),
        cost: dec(v.cost),
        weightGrams: v.weightGrams ?? null,
        lengthMm: v.lengthMm ?? null,
        widthMm: v.widthMm ?? null,
        heightMm: v.heightMm ?? null,
        imageMediaId: v.imageMediaId ?? null,
        isDefault,
        isActive: v.isActive ?? v.enabled ?? true,
        position: v.position ?? position,
        attributes: {
          create: (v.attributeValueIds ?? []).map((attributeValueId) => ({ attributeValueId })),
        },
      },
    });
    const stock = v.stock ?? 0;
    const inv = await tx.inventoryItem.create({
      data: {
        variantId: created.id,
        onHand: stock,
        lowStockThreshold: v.lowStockThreshold ?? 5,
        trackInventory: v.trackInventory ?? true,
        allowBackorder: v.allowBackorder ?? false,
      },
    });
    if (stock > 0)
      await tx.inventoryMovement.create({
        data: {
          itemId: inv.id,
          type: "ADJUSTMENT",
          quantity: stock,
          reason: "Initial stock",
          actorId,
          onHandAfter: stock,
          reservedAfter: 0,
        },
      });
    return created;
  }

  async function assertCombosUnique(
    tx: PrismaClient | Tx,
    productId: string | null,
    combos: { id?: string; ids: string[] }[],
    excludeVariantId?: string,
  ) {
    const seen = new Set<string>();
    const add = (ids: string[]) => {
      const k = comboKey(ids);
      if (seen.has(k)) throw AppError.conflict("Duplicate variant attribute combination");
      seen.add(k);
    };
    if (productId) {
      const existing = await tx.productVariant.findMany({
        where: { productId, ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}) },
        select: { id: true, attributes: { select: { attributeValueId: true } } },
      });
      for (const e of existing) add(e.attributes.map((a) => a.attributeValueId));
    }
    for (const c of combos) add(c.ids);
  }

  // ───── list ─────
  admin.get(
    "/products",
    requirePermission("products.read"),
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      const sort = typeof req.query.sort === "string" ? req.query.sort : "newest";
      const and: Prisma.ProductWhereInput[] = [];
      if (q)
        and.push({
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { slug: { contains: q, mode: "insensitive" } },
            { brand: { contains: q, mode: "insensitive" } },
            { variants: { some: { sku: { contains: q, mode: "insensitive" } } } },
          ],
        });
      if (status) {
        if (!["DRAFT", "ACTIVE", "ARCHIVED"].includes(status))
          throw AppError.validation("Invalid status filter");
        and.push({ status: status as "DRAFT" | "ACTIVE" | "ARCHIVED" });
      }
      if (category) and.push({ OR: [{ categoryId: category }, { category: { slug: category } }] });
      const where: Prisma.ProductWhereInput = and.length ? { AND: and } : {};

      const select = {
        id: true,
        title: true,
        slug: true,
        status: true,
        brand: true,
        isFeatured: true,
        publishAt: true,
        unpublishAt: true,
        createdAt: true,
        updatedAt: true,
        category: { select: { id: true, name: true, slug: true } },
        images: {
          orderBy: { position: "asc" },
          take: 1,
          select: { media: { select: { storageKey: true } } },
        },
        variants: {
          select: {
            price: true,
            isActive: true,
            inventory: { select: { onHand: true, reserved: true } },
          },
        },
      } satisfies Prisma.ProductSelect;

      let rows: Prisma.ProductGetPayload<{ select: typeof select }>[];
      let total: number;
      if (sort === "price_asc" || sort === "price_desc") {
        const mins = await p.productVariant.groupBy({
          by: ["productId"],
          where: { product: where },
          _min: { price: true },
        });
        const dir = sort === "price_asc" ? 1 : -1;
        mins.sort(
          (a, b) =>
            dir * a._min.price!.comparedTo(b._min.price!) || (a.productId < b.productId ? -1 : 1),
        );
        total = mins.length;
        const ids = mins
          .slice((pg.page - 1) * pg.pageSize, pg.page * pg.pageSize)
          .map((m) => m.productId);
        const found = await p.product.findMany({ where: { id: { in: ids } }, select });
        const byId = new Map(found.map((f) => [f.id, f]));
        rows = ids.map((i) => byId.get(i)).filter((x): x is (typeof rows)[number] => !!x);
      } else {
        const orderBy: Prisma.ProductOrderByWithRelationInput[] =
          sort === "oldest"
            ? [{ createdAt: "asc" }, { id: "asc" }]
            : sort === "title"
              ? [{ title: "asc" }, { id: "asc" }]
              : sort === "updated"
                ? [{ updatedAt: "desc" }, { id: "asc" }]
                : [{ createdAt: "desc" }, { id: "asc" }];
        [rows, total] = await Promise.all([
          p.product.findMany({
            where,
            select,
            orderBy,
            skip: (pg.page - 1) * pg.pageSize,
            take: pg.pageSize,
          }),
          p.product.count({ where }),
        ]);
      }
      const items = rows.map((r) => {
        const prices = r.variants.map((v) => v.price);
        const min = prices.reduce((a, b) => (b.lt(a) ? b : a), prices[0]!);
        const max = prices.reduce((a, b) => (b.gt(a) ? b : a), prices[0]!);
        return {
          id: r.id,
          title: r.title,
          slug: r.slug,
          status: r.status,
          visibility: visibility(r),
          brand: r.brand,
          isFeatured: r.isFeatured,
          category: r.category,
          image: r.images[0] ? ctx.providers.storage.url(r.images[0].media.storageKey) : null,
          variantCount: r.variants.length,
          priceMin: min ? min.toFixed(2) : null,
          priceMax: max ? max.toFixed(2) : null,
          totalAvailable: r.variants.reduce(
            (s, v) => s + (v.inventory ? availableQuantity(v.inventory) : 0),
            0,
          ),
          publishAt: r.publishAt,
          unpublishAt: r.unpublishAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      });
      res.json(paginated(items, total, pg));
    }),
  );

  admin.post(
    "/products/bulk-status",
    requirePermission("products.write"),
    h(async (req, res) => {
      const body = parse(bulkStatus, req.body);
      const r = await p.product.updateMany({
        where: { id: { in: body.ids } },
        data: { status: body.status },
      });
      await audit(ctx, req, {
        action: "product.bulkStatus",
        entityType: "Product",
        extra: { ids: body.ids.slice(0, 50), status: body.status, updated: r.count },
      });
      res.json({ updated: r.count });
    }),
  );

  admin.get(
    "/products/:id",
    requirePermission("products.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json(presentProduct(ctx, await loadFullOr404(id)));
    }),
  );

  // ───── create ─────
  admin.post(
    "/products",
    requirePermission("products.write"),
    h(async (req, res) => {
      const body = parse(createProduct, req.body);
      checkSchedule(body.publishAt, body.unpublishAt);
      await assertRefs(body);

      let variants: VariantCreate[];
      if (body.variants) {
        variants = body.variants;
      } else {
        if (body.price === undefined)
          throw AppError.validation("price is required (or provide variants)");
        variants = [
          {
            sku: body.sku ?? randomSku(),
            price: body.price,
            compareAtPrice: body.compareAtPrice,
            cost: body.cost,
            barcode: body.barcode,
            weightGrams: body.weightGrams,
            lengthMm: body.lengthMm,
            widthMm: body.widthMm,
            heightMm: body.heightMm,
            stock: body.stock,
            lowStockThreshold: body.lowStockThreshold,
            trackInventory: body.trackInventory,
            allowBackorder: body.allowBackorder,
          },
        ];
      }
      for (const v of variants) checkPrices(v.price, v.compareAtPrice);
      if (variants.length > 1 && variants.some((v) => !(v.attributeValueIds ?? []).length))
        throw AppError.validation(
          "Every variant of a multi-variant product needs attributeValueIds",
        );
      for (const v of variants) {
        await assertValueIds(p, v.attributeValueIds ?? [], true);
      }
      const variantMedia = variants.map((v) => v.imageMediaId).filter((x): x is string => !!x);
      if (variantMedia.length && (await missingMediaIds(p, variantMedia)).length)
        throw AppError.validation("Unknown variant media id");
      await assertCombosUnique(
        p,
        null,
        variants.map((v) => ({ ids: v.attributeValueIds ?? [] })),
      );
      await assertSkusFree(variants.map((v) => v.sku));

      if (body.slug && (await slugTaken(body.slug))) throw AppError.conflict("Slug already in use");
      const slug = body.slug ?? (await uniqueSlug(slugTaken, body.title));

      try {
        const id = await p.$transaction(async (tx) => {
          const product = await tx.product.create({
            data: {
              title: body.title,
              slug,
              shortDescription: body.shortDescription ? plain(body.shortDescription) : null,
              description: body.description ? sanitizeRich(body.description) : null,
              status: body.status ?? "DRAFT",
              categoryId: body.categoryId ?? null,
              taxClassId: body.taxClassId ?? null,
              brand: body.brand ?? null,
              isFeatured: body.isFeatured ?? false,
              isNew: body.isNew ?? false,
              publishAt: body.publishAt ?? null,
              unpublishAt: body.unpublishAt ?? null,
              seo: (body.seo ?? undefined) as Prisma.InputJsonValue | undefined,
              properties: (body.properties ?? undefined) as Prisma.InputJsonValue | undefined,
              images: {
                create: (body.imageMediaIds ?? []).map((mediaId, position) => ({
                  mediaId,
                  position,
                })),
              },
              attributeValues: {
                create: (body.attributeValueIds ?? []).map((attributeValueId) => ({
                  attributeValueId,
                })),
              },
            },
          });
          if (body.tags?.length) {
            const tagIds = await resolveTags(tx, body.tags);
            await tx.productTag.createMany({
              data: tagIds.map((tagId) => ({ productId: product.id, tagId })),
            });
          }
          if (body.collectionIds?.length)
            await tx.collectionProduct.createMany({
              data: body.collectionIds.map((collectionId) => ({
                collectionId,
                productId: product.id,
                position: 0,
              })),
            });
          for (const [i, v] of variants.entries())
            await createVariant(tx, product.id, v, i, i === 0, req.admin!.id);
          return product.id;
        });
        const full = await loadFullOr404(id);
        await audit(ctx, req, {
          action: "product.create",
          entityType: "Product",
          entityId: id,
          after: {
            title: full.title,
            slug: full.slug,
            status: full.status,
            variants: variants.length,
          },
        });
        res.status(201).json(presentProduct(ctx, full));
      } catch (err) {
        if (isUniqueViolation(err, "sku")) throw AppError.conflict("SKU already in use");
        if (isUniqueViolation(err, "slug")) throw AppError.conflict("Slug already in use");
        throw err;
      }
    }),
  );

  // ───── update ─────
  admin.patch(
    "/products/:id",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(updateProduct, req.body);
      const before = await loadFullOr404(id);
      checkSchedule(
        body.publishAt !== undefined ? body.publishAt : before.publishAt,
        body.unpublishAt !== undefined ? body.unpublishAt : before.unpublishAt,
      );
      await assertRefs(body);
      if (body.slug && body.slug !== before.slug && (await slugTaken(body.slug)))
        throw AppError.conflict("Slug already in use");

      const touchesVariant = [
        body.price,
        body.compareAtPrice,
        body.cost,
        body.sku,
        body.barcode,
      ].some((x) => x !== undefined);
      let single: FullVariant | undefined;
      if (touchesVariant) {
        if (before.variants.length !== 1)
          throw AppError.validation(
            "price/sku fields only apply to single-variant products; use the variant endpoints",
          );
        single = before.variants[0]!;
        checkPrices(
          body.price ?? single.price.toFixed(2),
          body.compareAtPrice !== undefined ? body.compareAtPrice : str(single.compareAtPrice),
        );
        if (body.sku && body.sku !== single.sku) await assertSkusFree([body.sku], [single.id]);
      }

      try {
        await p.$transaction(async (tx) => {
          await tx.product.update({
            where: { id },
            data: {
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.slug !== undefined ? { slug: body.slug } : {}),
              ...(body.shortDescription !== undefined
                ? { shortDescription: body.shortDescription ? plain(body.shortDescription) : null }
                : {}),
              ...(body.description !== undefined
                ? { description: body.description ? sanitizeRich(body.description) : null }
                : {}),
              ...(body.status !== undefined ? { status: body.status } : {}),
              ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
              ...(body.taxClassId !== undefined ? { taxClassId: body.taxClassId } : {}),
              ...(body.brand !== undefined ? { brand: body.brand } : {}),
              ...(body.isFeatured !== undefined ? { isFeatured: body.isFeatured } : {}),
              ...(body.isNew !== undefined ? { isNew: body.isNew } : {}),
              ...(body.publishAt !== undefined ? { publishAt: body.publishAt } : {}),
              ...(body.unpublishAt !== undefined ? { unpublishAt: body.unpublishAt } : {}),
              ...(body.seo !== undefined
                ? { seo: (body.seo ?? Prisma.DbNull) as Prisma.InputJsonValue }
                : {}),
              ...(body.properties !== undefined
                ? { properties: (body.properties ?? Prisma.DbNull) as Prisma.InputJsonValue }
                : {}),
            },
          });
          if (body.imageMediaIds) {
            await tx.productImage.deleteMany({ where: { productId: id } });
            await tx.productImage.createMany({
              data: body.imageMediaIds.map((mediaId, position) => ({
                productId: id,
                mediaId,
                position,
              })),
            });
          }
          if (body.attributeValueIds) {
            await tx.productAttributeValue.deleteMany({ where: { productId: id } });
            await tx.productAttributeValue.createMany({
              data: body.attributeValueIds.map((attributeValueId) => ({
                productId: id,
                attributeValueId,
              })),
            });
          }
          if (body.tags) {
            await tx.productTag.deleteMany({ where: { productId: id } });
            const tagIds = await resolveTags(tx, body.tags);
            await tx.productTag.createMany({
              data: tagIds.map((tagId) => ({ productId: id, tagId })),
            });
          }
          if (body.collectionIds) {
            await tx.collectionProduct.deleteMany({
              where: { productId: id, collection: { type: "MANUAL" } },
            });
            await tx.collectionProduct.createMany({
              data: body.collectionIds.map((collectionId) => ({
                collectionId,
                productId: id,
                position: 0,
              })),
            });
          }
          if (single)
            await tx.productVariant.update({
              where: { id: single.id },
              data: {
                ...(body.price !== undefined ? { price: new Prisma.Decimal(body.price) } : {}),
                ...(body.compareAtPrice !== undefined
                  ? { compareAtPrice: dec(body.compareAtPrice) }
                  : {}),
                ...(body.cost !== undefined ? { cost: dec(body.cost) } : {}),
                ...(body.sku !== undefined ? { sku: body.sku } : {}),
                ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
              },
            });
        });
      } catch (err) {
        if (isUniqueViolation(err, "sku")) throw AppError.conflict("SKU already in use");
        if (isUniqueViolation(err, "slug")) throw AppError.conflict("Slug already in use");
        throw err;
      }
      const after = await loadFullOr404(id);
      await audit(ctx, req, {
        action: "product.update",
        entityType: "Product",
        entityId: id,
        before: { title: before.title, status: before.status, slug: before.slug },
        after: { ...body, description: body.description !== undefined ? "[updated]" : undefined },
      });
      res.json(presentProduct(ctx, after));
    }),
  );

  admin.delete(
    "/products/:id",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const prod = await p.product.findUnique({ where: { id } });
      if (!prod) throw AppError.notFound("Product");
      const orders = await p.orderItem.count({
        where: { OR: [{ productId: id }, { variant: { productId: id } }] },
      });
      if (orders > 0)
        throw AppError.conflict("Product has order history; archive it instead of deleting", {
          orderItems: orders,
        });
      try {
        await p.product.delete({ where: { id } });
      } catch (err) {
        if (isFkViolation(err))
          throw AppError.conflict("Product is referenced and cannot be deleted");
        throw err;
      }
      await audit(ctx, req, {
        action: "product.delete",
        entityType: "Product",
        entityId: id,
        before: { title: prod.title, slug: prod.slug },
      });
      res.status(204).end();
    }),
  );

  admin.post(
    "/products/:id/duplicate",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const src = await loadFullOr404(id);
      const slug = await uniqueSlug(slugTaken, `${src.slug}-copy`);
      const skuTaken = async (s: string) =>
        !!(await p.productVariant.findUnique({ where: { sku: s }, select: { id: true } }));
      const newId = await p.$transaction(async (tx) => {
        const copy = await tx.product.create({
          data: {
            title: `Copy of ${src.title}`.slice(0, 250),
            slug,
            shortDescription: src.shortDescription,
            description: src.description,
            status: "DRAFT",
            categoryId: src.categoryId,
            taxClassId: src.taxClassId,
            brand: src.brand,
            isFeatured: false,
            isNew: src.isNew,
            seo: (src.seo ?? undefined) as Prisma.InputJsonValue | undefined,
            properties: (src.properties ?? undefined) as Prisma.InputJsonValue | undefined,
            images: {
              create: src.images.map((i) => ({ mediaId: i.mediaId, position: i.position })),
            },
            attributeValues: {
              create: src.attributeValues.map((a) => ({ attributeValueId: a.attributeValueId })),
            },
            tags: { create: src.tags.map((t) => ({ tagId: t.tagId })) },
          },
        });
        for (const [i, v] of src.variants.entries()) {
          let sku = `${v.sku}-COPY`;
          for (let n = 2; await skuTaken(sku); n++) sku = `${v.sku}-COPY${n}`;
          await createVariant(
            tx,
            copy.id,
            {
              sku,
              price: v.price.toFixed(2),
              compareAtPrice: str(v.compareAtPrice),
              cost: str(v.cost),
              barcode: null,
              title: v.title,
              weightGrams: v.weightGrams,
              lengthMm: v.lengthMm,
              widthMm: v.widthMm,
              heightMm: v.heightMm,
              imageMediaId: v.imageMediaId,
              isActive: v.isActive,
              position: v.position,
              attributeValueIds: v.attributes.map((a) => a.attributeValueId),
              stock: 0,
              lowStockThreshold: v.inventory?.lowStockThreshold,
              trackInventory: v.inventory?.trackInventory,
              allowBackorder: v.inventory?.allowBackorder,
            },
            i,
            v.isDefault,
            req.admin!.id,
          );
        }
        return copy.id;
      });
      await audit(ctx, req, {
        action: "product.duplicate",
        entityType: "Product",
        entityId: newId,
        extra: { sourceId: id },
      });
      res.status(201).json(presentProduct(ctx, await loadFullOr404(newId)));
    }),
  );

  // ───── variants ─────
  admin.post(
    "/products/:id/variants",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(variantCreate, req.body);
      const prod = await loadFullOr404(id);
      checkPrices(body.price, body.compareAtPrice);
      const ids = body.attributeValueIds ?? [];
      if (!ids.length)
        throw AppError.validation("attributeValueIds are required for additional variants");
      if (prod.variants.some((v) => v.attributes.length === 0))
        throw AppError.validation(
          "Assign attribute values to the existing variant first (PATCH it) before adding more",
        );
      await assertValueIds(p, ids, true);
      if (body.imageMediaId && (await missingMediaIds(p, [body.imageMediaId])).length)
        throw AppError.validation("Unknown media id");
      await assertCombosUnique(p, id, [{ ids }]);
      await assertSkusFree([body.sku]);
      try {
        const created = await p.$transaction((tx) =>
          createVariant(tx, id, body, prod.variants.length, false, req.admin!.id),
        );
        await audit(ctx, req, {
          action: "variant.create",
          entityType: "ProductVariant",
          entityId: created.id,
          after: { productId: id, sku: body.sku, price: body.price },
        });
        const full = await loadFullOr404(id);
        res.status(201).json(
          presentVariant(
            ctx,
            full.variants.find((v) => v.id === created.id)!,
          ),
        );
      } catch (err) {
        if (isUniqueViolation(err, "sku")) throw AppError.conflict("SKU already in use");
        throw err;
      }
    }),
  );

  admin.patch(
    "/products/:id/variants/:variantId",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id, variantId } = parse(variantParams, req.params);
      const body = parse(variantUpdate, req.body);
      const prod = await loadFullOr404(id);
      const cur = prod.variants.find((v) => v.id === variantId);
      if (!cur) throw AppError.notFound("Variant");
      checkPrices(
        body.price ?? cur.price.toFixed(2),
        body.compareAtPrice !== undefined ? body.compareAtPrice : str(cur.compareAtPrice),
      );
      if (body.sku && body.sku !== cur.sku) await assertSkusFree([body.sku], [variantId]);
      if (body.imageMediaId && (await missingMediaIds(p, [body.imageMediaId])).length)
        throw AppError.validation("Unknown media id");
      if (body.attributeValueIds) {
        if (!body.attributeValueIds.length && prod.variants.length > 1)
          throw AppError.validation("Variants of a multi-variant product need attribute values");
        await assertValueIds(p, body.attributeValueIds, true);
        await assertCombosUnique(p, id, [{ ids: body.attributeValueIds }], variantId);
      }
      const isActive = body.isActive ?? body.enabled;
      try {
        await p.$transaction(async (tx) => {
          await tx.productVariant.update({
            where: { id: variantId },
            data: {
              ...(body.sku !== undefined ? { sku: body.sku } : {}),
              ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.price !== undefined ? { price: new Prisma.Decimal(body.price) } : {}),
              ...(body.compareAtPrice !== undefined
                ? { compareAtPrice: dec(body.compareAtPrice) }
                : {}),
              ...(body.cost !== undefined ? { cost: dec(body.cost) } : {}),
              ...(body.weightGrams !== undefined ? { weightGrams: body.weightGrams } : {}),
              ...(body.lengthMm !== undefined ? { lengthMm: body.lengthMm } : {}),
              ...(body.widthMm !== undefined ? { widthMm: body.widthMm } : {}),
              ...(body.heightMm !== undefined ? { heightMm: body.heightMm } : {}),
              ...(body.imageMediaId !== undefined ? { imageMediaId: body.imageMediaId } : {}),
              ...(isActive !== undefined ? { isActive } : {}),
              ...(body.position !== undefined ? { position: body.position } : {}),
            },
          });
          if (body.attributeValueIds) {
            await tx.variantAttributeValue.deleteMany({ where: { variantId } });
            await tx.variantAttributeValue.createMany({
              data: body.attributeValueIds.map((attributeValueId) => ({
                variantId,
                attributeValueId,
              })),
            });
          }
        });
      } catch (err) {
        if (isUniqueViolation(err, "sku")) throw AppError.conflict("SKU already in use");
        throw err;
      }
      await audit(ctx, req, {
        action: "variant.update",
        entityType: "ProductVariant",
        entityId: variantId,
        before: { sku: cur.sku, price: cur.price.toFixed(2), isActive: cur.isActive },
        after: body,
      });
      const full = await loadFullOr404(id);
      res.json(
        presentVariant(
          ctx,
          full.variants.find((v) => v.id === variantId)!,
        ),
      );
    }),
  );

  admin.delete(
    "/products/:id/variants/:variantId",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id, variantId } = parse(variantParams, req.params);
      const prod = await loadFullOr404(id);
      const cur = prod.variants.find((v) => v.id === variantId);
      if (!cur) throw AppError.notFound("Variant");
      if (prod.variants.length <= 1)
        throw AppError.conflict("A product must keep at least one variant");
      const orders = await p.orderItem.count({ where: { variantId } });
      if (orders > 0)
        throw AppError.conflict("Variant has order history; disable it instead of deleting", {
          orderItems: orders,
        });
      await p.$transaction(async (tx) => {
        await tx.productVariant.delete({ where: { id: variantId } });
        if (cur.isDefault) {
          const next = prod.variants.find((v) => v.id !== variantId)!;
          await tx.productVariant.update({ where: { id: next.id }, data: { isDefault: true } });
        }
      });
      await audit(ctx, req, {
        action: "variant.delete",
        entityType: "ProductVariant",
        entityId: variantId,
        before: { productId: id, sku: cur.sku },
      });
      res.status(204).end();
    }),
  );
}
