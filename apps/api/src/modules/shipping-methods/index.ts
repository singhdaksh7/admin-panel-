import { Router } from "express";
import { z } from "zod";
import { AppError, toMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { listApplicableMethods, methodDto } from "./service";

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string like 5.00");
const base = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((s) => s.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  type: z.enum(["FLAT", "FREE_OVER", "PROVIDER_RATE"]).default("FLAT"),
  price: money.default("0.00"),
  freeOverAmount: money.nullish(),
  minDays: z.number().int().min(0).max(365).nullish(),
  maxDays: z.number().int().min(0).max(365).nullish(),
  countries: z
    .array(
      z
        .string()
        .length(2)
        .transform((s) => s.toUpperCase()),
    )
    .max(300)
    .default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

function check(b: {
  type?: string;
  freeOverAmount?: string | null;
  minDays?: number | null;
  maxDays?: number | null;
}) {
  if (b.type === "FREE_OVER" && (b.freeOverAmount == null || toMinor(b.freeOverAmount) <= 0))
    throw AppError.validation("freeOverAmount is required for FREE_OVER methods");
  if (b.minDays != null && b.maxDays != null && b.maxDays < b.minDays)
    throw AppError.validation("maxDays must be >= minDays");
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const pub = Router();
  const admin = Router();

  pub.get(
    "/checkout/shipping-methods",
    limiters.publicRead,
    h(async (req, res) => {
      const country = typeof req.query.country === "string" ? req.query.country : undefined;
      const sub =
        typeof req.query.subtotal === "string" && /^\d+(\.\d{1,2})?$/.test(req.query.subtotal)
          ? toMinor(req.query.subtotal)
          : undefined;
      const methods = await listApplicableMethods(p, country);
      res.json({ items: methods.map((m) => methodDto(m, sub)) });
    }),
  );

  admin.get(
    "/shipping-methods",
    requirePermission("settings.read"),
    h(async (_req, res) => {
      res.json({
        items: await p.shippingMethod.findMany({
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
      });
    }),
  );
  admin.post(
    "/shipping-methods",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const b = parse(base, req.body);
      check(b);
      if (await p.shippingMethod.findUnique({ where: { code: b.code } }))
        throw AppError.conflict("Shipping method code already exists");
      const created = await p.shippingMethod.create({ data: b });
      await audit(ctx, req, {
        action: "shipping_method.create",
        entityType: "ShippingMethod",
        entityId: created.id,
        after: b,
      });
      res.status(201).json(created);
    }),
  );
  admin.patch(
    "/shipping-methods/:id",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(base.partial(), req.body);
      const before = await p.shippingMethod.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Shipping method");
      check({
        type: b.type ?? before.type,
        freeOverAmount:
          b.freeOverAmount === undefined ? before.freeOverAmount?.toString() : b.freeOverAmount,
        minDays: b.minDays === undefined ? before.minDays : b.minDays,
        maxDays: b.maxDays === undefined ? before.maxDays : b.maxDays,
      });
      if (
        b.code &&
        b.code !== before.code &&
        (await p.shippingMethod.findUnique({ where: { code: b.code } }))
      )
        throw AppError.conflict("Shipping method code already exists");
      const updated = await p.shippingMethod.update({ where: { id }, data: b });
      await audit(ctx, req, {
        action: "shipping_method.update",
        entityType: "ShippingMethod",
        entityId: id,
        before,
        after: b,
      });
      res.json(updated);
    }),
  );
  admin.delete(
    "/shipping-methods/:id",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const before = await p.shippingMethod.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Shipping method");
      await p.shippingMethod.delete({ where: { id } });
      await audit(ctx, req, {
        action: "shipping_method.delete",
        entityType: "ShippingMethod",
        entityId: id,
        before,
      });
      res.json({ ok: true });
    }),
  );

  return { public: pub, admin };
}
