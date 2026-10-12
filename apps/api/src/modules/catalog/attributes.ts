import { Router } from "express";
import { z } from "zod";
import { AppError, slugify } from "@kash-commerce/shared";
import { Prisma } from "@kash-commerce/database";
import type { AppContext } from "../../context";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { isUniqueViolation, slugSchema, uniqueSlug } from "./common";

const attrBase = z.object({
  name: z.string().trim().min(1).max(80),
  slug: slugSchema.optional(),
  type: z.enum(["TEXT", "COLOR", "NUMBER"]).optional(),
  usedForVariants: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const valueBody = z.object({
  value: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  meta: z.record(z.unknown()).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const createAttr = attrBase.extend({ values: z.array(valueBody).max(200).optional() });
const taxBody = z.object({
  name: z.string().trim().min(1).max(80),
  rate: z.string().regex(/^\d{1,3}(\.\d{1,3})?$/),
  hsnCode: z.string().max(20).nullable().optional(),
});

const valueParam = z.object({ valueId: z.string().min(1).max(64) });

export function registerAttributes(ctx: AppContext, admin: Router) {
  const p = ctx.prisma;

  const attrSlugTaken = async (s: string) =>
    !!(await p.attribute.findUnique({ where: { slug: s }, select: { id: true } }));

  admin.get(
    "/attributes",
    requirePermission("products.read"),
    h(async (_req, res) => {
      const items = await p.attribute.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: { values: { orderBy: [{ sortOrder: "asc" }, { value: "asc" }] } },
      });
      res.json({ items });
    }),
  );

  admin.get(
    "/attributes/:id",
    requirePermission("products.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = await p.attribute.findUnique({
        where: { id },
        include: { values: { orderBy: [{ sortOrder: "asc" }, { value: "asc" }] } },
      });
      if (!a) throw AppError.notFound("Attribute");
      res.json(a);
    }),
  );

  admin.post(
    "/attributes",
    requirePermission("attributes.write"),
    h(async (req, res) => {
      const body = parse(createAttr, req.body);
      if (body.slug && (await attrSlugTaken(body.slug)))
        throw AppError.conflict("Slug already in use");
      const slug = body.slug ?? (await uniqueSlug(attrSlugTaken, body.name));
      const seen = new Set<string>();
      const values = (body.values ?? []).map((v, i) => {
        const vs =
          v.slug ??
          v.value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        if (!vs || seen.has(vs))
          throw AppError.validation(`Duplicate or empty value slug: ${v.value}`);
        seen.add(vs);
        return {
          value: v.value,
          slug: vs,
          sortOrder: v.sortOrder ?? i,
          meta: (v.meta ?? undefined) as Prisma.InputJsonValue | undefined,
        };
      });
      try {
        const a = await p.attribute.create({
          data: {
            name: body.name,
            slug,
            type: body.type ?? "TEXT",
            usedForVariants: body.usedForVariants ?? false,
            isFilterable: body.isFilterable ?? true,
            sortOrder: body.sortOrder ?? 0,
            values: { create: values },
          },
          include: { values: true },
        });
        await audit(ctx, req, {
          action: "attribute.create",
          entityType: "Attribute",
          entityId: a.id,
          after: { name: a.name, slug, values: values.length },
        });
        res.status(201).json(a);
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("Slug already in use");
        throw err;
      }
    }),
  );

  admin.patch(
    "/attributes/:id",
    requirePermission("attributes.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(attrBase.partial(), req.body);
      const before = await p.attribute.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Attribute");
      if (body.slug && body.slug !== before.slug && (await attrSlugTaken(body.slug)))
        throw AppError.conflict("Slug already in use");
      const a = await p.attribute.update({
        where: { id },
        data: body,
        include: { values: true },
      });
      await audit(ctx, req, {
        action: "attribute.update",
        entityType: "Attribute",
        entityId: id,
        before,
        after: body,
      });
      res.json(a);
    }),
  );

  admin.delete(
    "/attributes/:id",
    requirePermission("attributes.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const a = await p.attribute.findUnique({ where: { id } });
      if (!a) throw AppError.notFound("Attribute");
      const used =
        (await p.variantAttributeValue.count({ where: { attributeValue: { attributeId: id } } })) +
        (await p.productAttributeValue.count({ where: { attributeValue: { attributeId: id } } }));
      if (used > 0) throw AppError.conflict("Attribute is used by products", { usages: used });
      await p.attribute.delete({ where: { id } });
      await audit(ctx, req, {
        action: "attribute.delete",
        entityType: "Attribute",
        entityId: id,
        before: { name: a.name },
      });
      res.status(204).end();
    }),
  );

  admin.post(
    "/attributes/:id/values",
    requirePermission("attributes.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(valueBody, req.body);
      if (!(await p.attribute.findUnique({ where: { id }, select: { id: true } })))
        throw AppError.notFound("Attribute");
      const slug = body.slug ?? slugify(body.value);
      try {
        const v = await p.attributeValue.create({
          data: {
            attributeId: id,
            value: body.value,
            slug,
            sortOrder: body.sortOrder ?? 0,
            meta: (body.meta ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });
        await audit(ctx, req, {
          action: "attribute.value.create",
          entityType: "AttributeValue",
          entityId: v.id,
          after: { attributeId: id, value: v.value },
        });
        res.status(201).json(v);
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("Value slug already exists");
        throw err;
      }
    }),
  );

  admin.patch(
    "/attribute-values/:valueId",
    requirePermission("attributes.write"),
    h(async (req, res) => {
      const { valueId } = parse(valueParam, req.params);
      const body = parse(valueBody.partial(), req.body);
      const before = await p.attributeValue.findUnique({ where: { id: valueId } });
      if (!before) throw AppError.notFound("Attribute value");
      try {
        const v = await p.attributeValue.update({
          where: { id: valueId },
          data: {
            ...(body.value !== undefined ? { value: body.value } : {}),
            ...(body.slug !== undefined ? { slug: body.slug } : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...(body.meta !== undefined
              ? { meta: (body.meta ?? Prisma.DbNull) as Prisma.InputJsonValue }
              : {}),
          },
        });
        await audit(ctx, req, {
          action: "attribute.value.update",
          entityType: "AttributeValue",
          entityId: valueId,
          before,
          after: body,
        });
        res.json(v);
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("Value slug already exists");
        throw err;
      }
    }),
  );

  admin.delete(
    "/attribute-values/:valueId",
    requirePermission("attributes.write"),
    h(async (req, res) => {
      const { valueId } = parse(valueParam, req.params);
      const v = await p.attributeValue.findUnique({ where: { id: valueId } });
      if (!v) throw AppError.notFound("Attribute value");
      const used =
        (await p.variantAttributeValue.count({ where: { attributeValueId: valueId } })) +
        (await p.productAttributeValue.count({ where: { attributeValueId: valueId } }));
      if (used > 0) throw AppError.conflict("Value is used by products", { usages: used });
      await p.attributeValue.delete({ where: { id: valueId } });
      await audit(ctx, req, {
        action: "attribute.value.delete",
        entityType: "AttributeValue",
        entityId: valueId,
        before: { value: v.value },
      });
      res.status(204).end();
    }),
  );

  // ───── tags (created implicitly through product payloads) ─────
  admin.get(
    "/tags",
    requirePermission("products.read"),
    h(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 60) : "";
      const items = await p.tag.findMany({
        where: q ? { name: { contains: q, mode: "insensitive" } } : {},
        orderBy: { name: "asc" },
        take: 200,
      });
      res.json({ items });
    }),
  );

  // ───── tax classes ─────
  admin.get(
    "/tax-classes",
    requirePermission("products.read"),
    h(async (_req, res) => {
      const items = await p.taxClass.findMany({
        orderBy: { name: "asc" },
        include: { _count: { select: { products: true } } },
      });
      res.json({
        items: items.map(({ _count, rate, ...t }) => ({
          ...t,
          rate: rate.toString(),
          productCount: _count.products,
        })),
      });
    }),
  );

  admin.post(
    "/tax-classes",
    requirePermission("products.write"),
    h(async (req, res) => {
      const body = parse(taxBody, req.body);
      if (Number(body.rate) > 100) throw AppError.validation("Rate must be between 0 and 100");
      try {
        const t = await p.taxClass.create({
          data: {
            name: body.name,
            rate: new Prisma.Decimal(body.rate),
            hsnCode: body.hsnCode ?? null,
          },
        });
        await audit(ctx, req, {
          action: "taxclass.create",
          entityType: "TaxClass",
          entityId: t.id,
          after: body,
        });
        res.status(201).json({ ...t, rate: t.rate.toString() });
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("A tax class with that name exists");
        throw err;
      }
    }),
  );

  admin.patch(
    "/tax-classes/:id",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(taxBody.partial(), req.body);
      if (body.rate !== undefined && Number(body.rate) > 100)
        throw AppError.validation("Rate must be between 0 and 100");
      if (!(await p.taxClass.findUnique({ where: { id }, select: { id: true } })))
        throw AppError.notFound("Tax class");
      try {
        const t = await p.taxClass.update({
          where: { id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.rate !== undefined ? { rate: new Prisma.Decimal(body.rate) } : {}),
            ...(body.hsnCode !== undefined ? { hsnCode: body.hsnCode } : {}),
          },
        });
        await audit(ctx, req, {
          action: "taxclass.update",
          entityType: "TaxClass",
          entityId: id,
          after: body,
        });
        res.json({ ...t, rate: t.rate.toString() });
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("A tax class with that name exists");
        throw err;
      }
    }),
  );

  admin.delete(
    "/tax-classes/:id",
    requirePermission("products.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const t = await p.taxClass.findUnique({
        where: { id },
        include: { _count: { select: { products: true } } },
      });
      if (!t) throw AppError.notFound("Tax class");
      if (t._count.products > 0)
        throw AppError.conflict("Tax class is assigned to products", {
          productCount: t._count.products,
        });
      await p.taxClass.delete({ where: { id } });
      await audit(ctx, req, {
        action: "taxclass.delete",
        entityType: "TaxClass",
        entityId: id,
        before: { name: t.name },
      });
      res.status(204).end();
    }),
  );
}
