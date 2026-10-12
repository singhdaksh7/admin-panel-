import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@kash-commerce/database";
import { AppError, clampPage, paginated, slugify } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import {
  collectMediaIds,
  sectionTypeEnum,
  validateSectionContent,
  SECTION_TYPES,
} from "./sectionTypes";
import {
  isPublishedNow,
  mediaUrlMap,
  resolveSectionContent,
  sectionVisibleWhere,
  withMediaUrls,
} from "./resolve";

export const seoJson = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    canonicalUrl: z.string().url().max(500).optional(),
    ogImageMediaId: z.string().max(64).nullable().optional(),
    noindex: z.boolean().optional(),
    nofollow: z.boolean().optional(),
  })
  .strict();

const slugField = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a slug (lowercase letters, digits, hyphens)");
const date = z.coerce.date();

const pageCreate = z.object({
  slug: slugField.optional(),
  title: z.string().min(1).max(200),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
  seo: seoJson.nullable().optional(),
  publishAt: date.nullable().optional(),
});
const pageUpdate = pageCreate.partial();

const sectionBase = {
  key: z.string().min(1).max(80).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isEnabled: z.boolean().optional(),
  startsAt: date.nullable().optional(),
  endsAt: date.nullable().optional(),
};
const sectionCreate = z.object({
  type: sectionTypeEnum,
  content: z.unknown(),
  ...sectionBase,
});
const sectionUpdate = z.object({ content: z.unknown().optional(), ...sectionBase });
const reorderBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

function checkWindow(startsAt?: Date | null, endsAt?: Date | null) {
  if (startsAt && endsAt && endsAt <= startsAt)
    throw AppError.validation("endsAt must be after startsAt", [
      { path: "endsAt", message: "must be after startsAt" },
    ]);
}

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");

  // ─────────────── public ───────────────
  const pub = Router();
  pub.get(
    "/pages",
    limiters.publicRead,
    h(async (_req, res) => {
      const now = new Date();
      const rows = await p.page.findMany({
        where: { status: "PUBLISHED", OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
        select: { slug: true, title: true },
        orderBy: { title: "asc" },
      });
      res.set("Cache-Control", "public, max-age=30");
      res.json({ items: rows });
    }),
  );
  pub.get(
    "/pages/:slug",
    limiters.publicRead,
    h(async (req, res) => {
      const now = new Date();
      const page = await p.page.findUnique({ where: { slug: String(req.params.slug) } });
      if (!page || !isPublishedNow(page, now)) throw AppError.notFound("Page");
      const sections = await p.pageSection.findMany({
        where: { pageId: page.id, ...sectionVisibleWhere(now) },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });
      const resolved = await Promise.all(
        sections.map((s) =>
          resolveSectionContent(ctx, s.type, s.content as Record<string, unknown>),
        ),
      );
      const seo = (page.seo ?? null) as { ogImageMediaId?: string | null } | null;
      const urls = await mediaUrlMap(ctx, [
        ...resolved.flatMap((c) => [...collectMediaIds(c)]),
        seo?.ogImageMediaId,
      ]);
      res.set("Cache-Control", "public, max-age=30");
      res.json({
        slug: page.slug,
        title: page.title,
        seo: seo ? withMediaUrls(seo, urls) : null,
        sections: sections.map((s, i) => ({
          id: s.id,
          type: s.type,
          key: s.key,
          sortOrder: s.sortOrder,
          content: withMediaUrls(resolved[i], urls),
        })),
      });
    }),
  );

  // ─────────────── admin ───────────────
  const admin = Router();
  const read = requirePermission("content.read");
  const write = requirePermission("content.write");

  admin.get(
    "/content/section-types",
    read,
    h(async (_req, res) => {
      res.json({ types: SECTION_TYPES });
    }),
  );

  admin.get(
    "/pages",
    read,
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const status =
        req.query.status === "DRAFT" || req.query.status === "PUBLISHED"
          ? (req.query.status as "DRAFT" | "PUBLISHED")
          : undefined;
      const where = {
        ...(status ? { status } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" as const } },
                { slug: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        p.page.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
          include: { _count: { select: { sections: true } } },
        }),
        p.page.count({ where }),
      ]);
      res.json(paginated(items, total, pg));
    }),
  );

  async function loadPage(idOrSlug: string) {
    const page = await p.page.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: { sections: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
    if (!page) throw AppError.notFound("Page");
    return page;
  }

  /** Admin read = draft preview: all sections regardless of status/schedule. */
  admin.get(
    "/pages/:id",
    read,
    h(async (req, res) => {
      const page = await loadPage(parse(idParam, req.params).id);
      const withItems = req.query.resolve === "true";
      const sections = withItems
        ? await Promise.all(
            page.sections.map(async (s) => ({
              ...s,
              content: await resolveSectionContent(
                ctx,
                s.type,
                s.content as Record<string, unknown>,
              ),
            })),
          )
        : page.sections;
      res.json({ ...page, sections });
    }),
  );

  admin.post(
    "/pages",
    write,
    h(async (req, res) => {
      const body = parse(pageCreate, req.body);
      const slug = body.slug ?? slugify(body.title);
      if (await p.page.findUnique({ where: { slug } }))
        throw AppError.conflict("Slug already in use");
      const page = await p.page.create({
        data: {
          slug,
          title: body.title,
          status: body.status,
          publishAt: body.publishAt ?? null,
          ...(body.seo ? { seo: body.seo } : {}),
        },
      });
      await audit(ctx, req, {
        action: "page.create",
        entityType: "Page",
        entityId: page.id,
        after: page,
      });
      res.status(201).json(page);
    }),
  );

  admin.patch(
    "/pages/:id",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(pageUpdate, req.body);
      const before = await p.page.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Page");
      if (
        body.slug &&
        body.slug !== before.slug &&
        (await p.page.findUnique({ where: { slug: body.slug } }))
      )
        throw AppError.conflict("Slug already in use");
      const { seo, ...rest } = body;
      const page = await p.page.update({
        where: { id },
        data: {
          ...rest,
          ...(seo !== undefined ? { seo: seo === null ? Prisma.DbNull : seo } : {}),
        },
      });
      await audit(ctx, req, {
        action: "page.update",
        entityType: "Page",
        entityId: id,
        before,
        after: page,
      });
      res.json(page);
    }),
  );

  admin.delete(
    "/pages/:id",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const before = await p.page.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Page");
      await p.page.delete({ where: { id } });
      await audit(ctx, req, { action: "page.delete", entityType: "Page", entityId: id, before });
      res.status(204).end();
    }),
  );

  admin.post(
    "/pages/:id/sections",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(sectionCreate, req.body);
      if (!(await p.page.findUnique({ where: { id }, select: { id: true } })))
        throw AppError.notFound("Page");
      const content = validateSectionContent(body.type, body.content);
      checkWindow(body.startsAt, body.endsAt);
      let sortOrder = body.sortOrder;
      if (sortOrder === undefined) {
        const last = await p.pageSection.aggregate({
          where: { pageId: id },
          _max: { sortOrder: true },
        });
        sortOrder = (last._max.sortOrder ?? -1) + 1;
      }
      const section = await p.pageSection.create({
        data: {
          pageId: id,
          type: body.type,
          key: body.key ?? null,
          content: content as object,
          sortOrder,
          isEnabled: body.isEnabled ?? true,
          startsAt: body.startsAt ?? null,
          endsAt: body.endsAt ?? null,
        },
      });
      await audit(ctx, req, {
        action: "page.section.create",
        entityType: "PageSection",
        entityId: section.id,
        extra: { pageId: id, type: body.type },
      });
      res.status(201).json(section);
    }),
  );

  admin.put(
    "/pages/:id/sections/reorder",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { ids } = parse(reorderBody, req.body);
      if (new Set(ids).size !== ids.length) throw AppError.validation("Duplicate section ids");
      const existing = await p.pageSection.findMany({
        where: { pageId: id },
        select: { id: true },
      });
      const have = new Set(existing.map((e) => e.id));
      if (ids.some((i) => !have.has(i)) || ids.length !== have.size)
        throw AppError.validation("ids must list every section of the page exactly once");
      await p.$transaction(
        ids.map((sid, i) => p.pageSection.update({ where: { id: sid }, data: { sortOrder: i } })),
      );
      await audit(ctx, req, {
        action: "page.section.reorder",
        entityType: "Page",
        entityId: id,
        extra: { ids },
      });
      res.json((await loadPage(id)).sections);
    }),
  );

  admin.patch(
    "/pages/:id/sections/:sectionId",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const sectionId = String(req.params.sectionId);
      const body = parse(sectionUpdate, req.body);
      const before = await p.pageSection.findFirst({ where: { id: sectionId, pageId: id } });
      if (!before) throw AppError.notFound("Section");
      const content =
        body.content !== undefined ? validateSectionContent(before.type, body.content) : undefined;
      checkWindow(
        body.startsAt === undefined ? before.startsAt : body.startsAt,
        body.endsAt === undefined ? before.endsAt : body.endsAt,
      );
      const { content: _c, ...rest } = body;
      void _c;
      const section = await p.pageSection.update({
        where: { id: sectionId },
        data: { ...rest, ...(content ? { content: content as object } : {}) },
      });
      await audit(ctx, req, {
        action: "page.section.update",
        entityType: "PageSection",
        entityId: sectionId,
        extra: { pageId: id },
      });
      res.json(section);
    }),
  );

  admin.delete(
    "/pages/:id/sections/:sectionId",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const sectionId = String(req.params.sectionId);
      const before = await p.pageSection.findFirst({ where: { id: sectionId, pageId: id } });
      if (!before) throw AppError.notFound("Section");
      await p.pageSection.delete({ where: { id: sectionId } });
      await audit(ctx, req, {
        action: "page.section.delete",
        entityType: "PageSection",
        entityId: sectionId,
        extra: { pageId: id },
      });
      res.status(204).end();
    }),
  );

  return { public: pub, admin };
}
