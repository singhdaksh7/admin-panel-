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
import { getSettings } from "../store";
import { sanitizeRichHtml, stripHtml } from "../content/sanitize";
import { mediaUrlMap, publishedBlogPosts } from "../content/resolve";
import { seoJson } from "../content";

const slugField = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a slug (lowercase letters, digits, hyphens)");
const create = z.object({
  title: z.string().trim().min(1).max(200),
  slug: slugField.optional(),
  excerpt: z.string().max(500).nullable().optional(),
  body: z.string().max(200_000).default(""),
  coverMediaId: z.string().max(64).nullable().optional(),
  authorName: z.string().max(120).nullable().optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
  publishAt: z.coerce.date().nullable().optional(),
  seo: seoJson.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
const update = create.partial();

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");

  async function uniqueSlug(base: string, ignoreId?: string) {
    let slug = base;
    for (let n = 2; ; n++) {
      const hit = await p.blogPost.findUnique({ where: { slug }, select: { id: true } });
      if (!hit || hit.id === ignoreId) return slug;
      slug = `${base}-${n}`.slice(0, 130);
    }
  }
  async function blogEnabled() {
    const f = (await getSettings(ctx)).features as { blog?: boolean } | null;
    return f?.blog !== false;
  }

  const pub = Router();
  pub.get(
    "/blog",
    limiters.publicRead,
    h(async (req, res) => {
      if (!(await blogEnabled())) throw AppError.notFound("Blog");
      const pg = clampPage(req.query.page, req.query.pageSize, 10);
      const tag = typeof req.query.tag === "string" && req.query.tag ? req.query.tag : undefined;
      const now = new Date();
      const where = {
        status: "PUBLISHED" as const,
        OR: [{ publishAt: null }, { publishAt: { lte: now } }],
        ...(tag ? { tags: { has: tag } } : {}),
      };
      const [items, total] = await Promise.all([
        publishedBlogPosts(ctx, { limit: pg.pageSize, skip: (pg.page - 1) * pg.pageSize, tag }),
        p.blogPost.count({ where }),
      ]);
      res.set("Cache-Control", "public, max-age=30");
      res.json(paginated(items, total, pg));
    }),
  );
  pub.get(
    "/blog/:slug",
    limiters.publicRead,
    h(async (req, res) => {
      if (!(await blogEnabled())) throw AppError.notFound("Blog");
      const now = new Date();
      const post = await p.blogPost.findFirst({
        where: {
          slug: String(req.params.slug),
          status: "PUBLISHED",
          OR: [{ publishAt: null }, { publishAt: { lte: now } }],
        },
      });
      if (!post) throw AppError.notFound("Post");
      const seo = (post.seo ?? null) as { ogImageMediaId?: string | null } | null;
      const urls = await mediaUrlMap(ctx, [post.coverMediaId, seo?.ogImageMediaId]);
      res.json({
        id: post.id,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        body: post.body,
        authorName: post.authorName,
        tags: post.tags,
        coverUrl: post.coverMediaId ? (urls.get(post.coverMediaId) ?? null) : null,
        publishedAt: post.publishAt ?? post.createdAt,
        updatedAt: post.updatedAt,
        seo: seo
          ? {
              ...seo,
              ogImageUrl: seo.ogImageMediaId ? (urls.get(seo.ogImageMediaId) ?? null) : null,
            }
          : null,
      });
    }),
  );

  const admin = Router();
  const read = requirePermission("content.read");
  const write = requirePermission("blog.write");

  admin.get(
    "/blog",
    read,
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const status =
        req.query.status === "DRAFT" || req.query.status === "PUBLISHED"
          ? (req.query.status as "DRAFT" | "PUBLISHED")
          : undefined;
      const where: Prisma.BlogPostWhereInput = {
        ...(status ? { status } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { slug: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        p.blogPost.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
          omit: { body: true },
        }),
        p.blogPost.count({ where }),
      ]);
      res.json(paginated(items, total, pg));
    }),
  );
  admin.get(
    "/blog/:id",
    read,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const post = await p.blogPost.findFirst({ where: { OR: [{ id }, { slug: id }] } });
      if (!post) throw AppError.notFound("Post");
      res.json(post);
    }),
  );
  admin.post(
    "/blog",
    write,
    h(async (req, res) => {
      const b = parse(create, req.body);
      const slug = await uniqueSlug(b.slug ?? slugify(b.title));
      if (b.slug && slug !== b.slug) throw AppError.conflict("Slug already in use");
      const post = await p.blogPost.create({
        data: {
          slug,
          title: stripHtml(b.title),
          excerpt: b.excerpt ? stripHtml(b.excerpt) : null,
          body: sanitizeRichHtml(b.body),
          coverMediaId: b.coverMediaId ?? null,
          authorName: b.authorName ?? null,
          status: b.status,
          publishAt: b.publishAt ?? null,
          tags: b.tags,
          ...(b.seo ? { seo: b.seo } : {}),
        },
      });
      await audit(ctx, req, {
        action: "blog.create",
        entityType: "BlogPost",
        entityId: post.id,
        extra: { slug },
      });
      res.status(201).json(post);
    }),
  );
  admin.patch(
    "/blog/:id",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(update, req.body);
      const before = await p.blogPost.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Post");
      if (
        b.slug &&
        b.slug !== before.slug &&
        (await p.blogPost.findUnique({ where: { slug: b.slug } }))
      )
        throw AppError.conflict("Slug already in use");
      const { seo, body, title, excerpt, ...rest } = b;
      const post = await p.blogPost.update({
        where: { id },
        data: {
          ...rest,
          ...(title !== undefined ? { title: stripHtml(title) } : {}),
          ...(excerpt !== undefined ? { excerpt: excerpt ? stripHtml(excerpt) : null } : {}),
          ...(body !== undefined ? { body: sanitizeRichHtml(body) } : {}),
          ...(seo !== undefined ? { seo: seo === null ? Prisma.DbNull : seo } : {}),
        },
      });
      await audit(ctx, req, {
        action: "blog.update",
        entityType: "BlogPost",
        entityId: id,
        before: { status: before.status, slug: before.slug },
        after: { status: post.status, slug: post.slug },
      });
      res.json(post);
    }),
  );
  admin.delete(
    "/blog/:id",
    write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const before = await p.blogPost.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Post");
      await p.blogPost.delete({ where: { id } });
      await audit(ctx, req, {
        action: "blog.delete",
        entityType: "BlogPost",
        entityId: id,
        before: { slug: before.slug },
      });
      res.status(204).end();
    }),
  );

  return { public: pub, admin };
}
