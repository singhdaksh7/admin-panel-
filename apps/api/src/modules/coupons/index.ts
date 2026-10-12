import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@kash-commerce/database";
import { AppError, clampPage, paginated, toMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string like 10.00");
const code = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, "letters, digits, - and _ only")
  .transform((s) => s.toUpperCase());

const base = z.object({
  code,
  description: z.string().max(300).nullish(),
  discountType: z.enum(["FIXED", "PERCENTAGE"]),
  value: money,
  minOrderAmount: money.nullish(),
  maxDiscount: money.nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  usageLimit: z.number().int().min(1).nullish(),
  perCustomerLimit: z.number().int().min(1).nullish(),
  isActive: z.boolean().default(true),
  productIds: z.array(z.string().max(64)).max(500).default([]),
  categoryIds: z.array(z.string().max(64)).max(200).default([]),
});

function refine(b: Partial<z.infer<typeof base>>) {
  if (b.discountType === "PERCENTAGE" && b.value !== undefined && toMinor(b.value) > 10000)
    throw AppError.validation("Percentage must be between 0 and 100");
  if (b.value !== undefined && toMinor(b.value) <= 0)
    throw AppError.validation("Value must be greater than 0");
  if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt)
    throw AppError.validation("endsAt must be after startsAt");
}

const createBody = base;
const updateBody = base.partial();

const include = { products: true, categories: true } satisfies Prisma.CouponInclude;

function dto(c: Prisma.CouponGetPayload<{ include: typeof include }>) {
  const { products, categories, ...rest } = c;
  return {
    ...rest,
    value: c.value.toString(),
    minOrderAmount: c.minOrderAmount?.toString() ?? null,
    maxDiscount: c.maxDiscount?.toString() ?? null,
    productIds: products.map((p) => p.productId),
    categoryIds: categories.map((x) => x.categoryId),
  };
}

export function register(ctx: AppContext): ModuleRoutes {
  const admin = Router();
  const p = ctx.prisma;

  admin.get(
    "/coupons",
    requirePermission("coupons.read"),
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const where: Prisma.CouponWhereInput = {
        ...(q ? { code: { contains: q, mode: "insensitive" } } : {}),
        ...(req.query.active === "true" ? { isActive: true } : {}),
        ...(req.query.active === "false" ? { isActive: false } : {}),
      };
      const [rows, total] = await Promise.all([
        p.coupon.findMany({
          where,
          include,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        p.coupon.count({ where }),
      ]);
      res.json(paginated(rows.map(dto), total, { page, pageSize }));
    }),
  );

  admin.get(
    "/coupons/:id",
    requirePermission("coupons.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const c = await p.coupon.findUnique({ where: { id }, include });
      if (!c) throw AppError.notFound("Coupon");
      res.json(dto(c));
    }),
  );

  admin.post(
    "/coupons",
    requirePermission("coupons.write"),
    h(async (req, res) => {
      const b = parse(createBody, req.body);
      refine(b);
      if (await p.coupon.findUnique({ where: { code: b.code } }))
        throw AppError.conflict("Coupon code already exists");
      const { productIds, categoryIds, ...data } = b;
      const created = await p.coupon.create({
        data: {
          ...data,
          products: { create: productIds.map((productId) => ({ productId })) },
          categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
        },
        include,
      });
      await audit(ctx, req, {
        action: "coupon.create",
        entityType: "Coupon",
        entityId: created.id,
        after: b,
      });
      res.status(201).json(dto(created));
    }),
  );

  admin.patch(
    "/coupons/:id",
    requirePermission("coupons.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(updateBody, req.body);
      const before = await p.coupon.findUnique({ where: { id }, include });
      if (!before) throw AppError.notFound("Coupon");
      refine({
        discountType: b.discountType ?? before.discountType,
        value: b.value ?? before.value.toString(),
        startsAt: b.startsAt === undefined ? before.startsAt : b.startsAt,
        endsAt: b.endsAt === undefined ? before.endsAt : b.endsAt,
      });
      if (
        b.code &&
        b.code !== before.code &&
        (await p.coupon.findUnique({ where: { code: b.code } }))
      )
        throw AppError.conflict("Coupon code already exists");
      const { productIds, categoryIds, ...data } = b;
      const updated = await p.$transaction(async (tx) => {
        if (productIds) {
          await tx.couponProduct.deleteMany({ where: { couponId: id } });
          await tx.couponProduct.createMany({
            data: productIds.map((productId) => ({ couponId: id, productId })),
          });
        }
        if (categoryIds) {
          await tx.couponCategory.deleteMany({ where: { couponId: id } });
          await tx.couponCategory.createMany({
            data: categoryIds.map((categoryId) => ({ couponId: id, categoryId })),
          });
        }
        return tx.coupon.update({ where: { id }, data, include });
      });
      await audit(ctx, req, {
        action: "coupon.update",
        entityType: "Coupon",
        entityId: id,
        before: dto(before),
        after: b,
      });
      res.json(dto(updated));
    }),
  );

  admin.delete(
    "/coupons/:id",
    requirePermission("coupons.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const c = await p.coupon.findUnique({ where: { id } });
      if (!c) throw AppError.notFound("Coupon");
      if ((await p.couponRedemption.count({ where: { couponId: id } })) > 0)
        throw AppError.conflict("Coupon has been redeemed; deactivate it instead");
      await p.coupon.delete({ where: { id } });
      await audit(ctx, req, {
        action: "coupon.delete",
        entityType: "Coupon",
        entityId: id,
        before: { code: c.code },
      });
      res.json({ ok: true });
    }),
  );

  return { admin };
}
