import { Router } from "express";
import { z } from "zod";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { computeFilters, resolveFilterGroups } from "./service";

const SOURCES = [
  "CATEGORY",
  "COLLECTION",
  "PRICE",
  "STOCK",
  "ATTRIBUTE",
  "TAG",
  "PROPERTY",
] as const;

const groupFields = {
  source: z.enum(SOURCES),
  attributeId: z.string().min(1).max(64).nullable().optional(),
  propertyKey: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only")
    .nullable()
    .optional(),
  label: z.string().min(1).max(80),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isEnabled: z.boolean().default(true),
  defaultOpen: z.boolean().default(true),
  multiSelect: z.boolean().default(true),
  showDesktop: z.boolean().default(true),
  showMobile: z.boolean().default(true),
  inheritToChildren: z.boolean().default(true),
};
const groupBody = z.object({
  categoryId: z.string().min(1).max(64).nullable().optional(),
  ...groupFields,
});
const groupItem = z.object(groupFields);
const groupPatch = z.object(groupFields).partial();
const bulkBody = z.object({ groups: z.array(groupItem).max(50) });

function checkSourceFields(g: {
  source: string;
  attributeId?: string | null;
  propertyKey?: string | null;
}) {
  if (g.source === "ATTRIBUTE" && !g.attributeId)
    throw AppError.validation("attributeId is required for ATTRIBUTE filters");
  if (g.source === "PROPERTY" && !g.propertyKey)
    throw AppError.validation("propertyKey is required for PROPERTY filters");
}

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");

  const pub = Router();
  pub.get(
    "/filters",
    limiters.publicRead,
    h(async (req, res) => {
      if (typeof req.query.category === "string" && req.query.category) {
        const c = await p.category.findFirst({
          where: { slug: req.query.category, isActive: true },
          select: { id: true },
        });
        if (!c) throw AppError.notFound("Category");
      }
      res.set("Cache-Control", "public, max-age=30");
      res.json(await computeFilters(p, req.query as Record<string, unknown>));
    }),
  );

  const admin = Router();
  const w = requirePermission("filters.write");

  async function validateAttr(g: { source: string; attributeId?: string | null }) {
    if (g.source === "ATTRIBUTE" && g.attributeId) {
      if (!(await p.attribute.findUnique({ where: { id: g.attributeId }, select: { id: true } })))
        throw AppError.validation("Unknown attributeId", [
          { path: "attributeId", message: "not found" },
        ]);
    }
  }
  async function scopeId(raw: string): Promise<string | null> {
    if (raw === "global") return null;
    if (!(await p.category.findUnique({ where: { id: raw }, select: { id: true } })))
      throw AppError.notFound("Category");
    return raw;
  }

  admin.get(
    "/filters",
    w,
    h(async (req, res) => {
      const cid = typeof req.query.categoryId === "string" ? req.query.categoryId : undefined;
      const where = cid === undefined ? {} : { categoryId: cid === "global" ? null : cid };
      res.json({
        items: await p.filterGroup.findMany({
          where,
          orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }],
        }),
      });
    }),
  );

  /** Effective (resolved, inheritance applied) groups for a category or "global". */
  admin.get(
    "/filters/effective/:categoryId",
    w,
    h(async (req, res) => {
      const cid = await scopeId(String(req.params.categoryId));
      res.json({ items: await resolveFilterGroups(p, cid) });
    }),
  );

  admin.post(
    "/filters",
    w,
    h(async (req, res) => {
      const body = parse(groupBody, req.body);
      checkSourceFields(body);
      await validateAttr(body);
      const categoryId = body.categoryId ? await scopeId(body.categoryId) : null;
      const last = await p.filterGroup.aggregate({
        where: { categoryId },
        _max: { sortOrder: true },
      });
      const g = await p.filterGroup.create({
        data: { ...body, categoryId, sortOrder: body.sortOrder ?? (last._max.sortOrder ?? -1) + 1 },
      });
      await audit(ctx, req, {
        action: "filter.create",
        entityType: "FilterGroup",
        entityId: g.id,
        after: g,
      });
      res.status(201).json(g);
    }),
  );

  admin.patch(
    "/filters/:id",
    w,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(groupPatch, req.body);
      const before = await p.filterGroup.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Filter group");
      const merged = { ...before, ...body };
      checkSourceFields(merged);
      await validateAttr(merged);
      const g = await p.filterGroup.update({ where: { id }, data: body });
      await audit(ctx, req, {
        action: "filter.update",
        entityType: "FilterGroup",
        entityId: id,
        before,
        after: g,
      });
      res.json(g);
    }),
  );

  admin.delete(
    "/filters/:id",
    w,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const before = await p.filterGroup.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Filter group");
      await p.filterGroup.delete({ where: { id } });
      await audit(ctx, req, {
        action: "filter.delete",
        entityType: "FilterGroup",
        entityId: id,
        before,
      });
      res.status(204).end();
    }),
  );

  /** Replace ALL groups of one scope ("global" or a category id). Array order = sortOrder. */
  admin.put(
    "/filters/scope/:categoryId",
    w,
    h(async (req, res) => {
      const categoryId = await scopeId(String(req.params.categoryId));
      const { groups } = parse(bulkBody, req.body);
      const seen = new Set<string>();
      for (const [i, g] of groups.entries()) {
        checkSourceFields(g);
        await validateAttr(g);
        const k = `${g.source}:${g.attributeId ?? ""}:${g.propertyKey ?? ""}`;
        if (seen.has(k))
          throw AppError.validation("Duplicate filter definition", [
            { path: `groups.${i}`, message: "same source/attribute/property appears twice" },
          ]);
        seen.add(k);
      }
      await p.$transaction([
        p.filterGroup.deleteMany({ where: { categoryId } }),
        p.filterGroup.createMany({
          data: groups.map((g, i) => ({ ...g, categoryId, sortOrder: g.sortOrder ?? i })),
        }),
      ]);
      await audit(ctx, req, {
        action: "filter.bulk",
        entityType: "FilterGroup",
        entityId: categoryId ?? "global",
        extra: { count: groups.length },
      });
      res.json({
        items: await p.filterGroup.findMany({
          where: { categoryId },
          orderBy: { sortOrder: "asc" },
        }),
      });
    }),
  );

  return { public: pub, admin };
}
