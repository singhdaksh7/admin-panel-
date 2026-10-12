import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@kash-commerce/database";
import { AppError, clampPage, paginated } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { publishedWhere } from "../../lib/productQuery";
import { getSettings } from "../store";
import { stripHtml } from "../content/sanitize";
import { getRatingAggregates } from "./service";

export { getRatingAggregates } from "./service";

const submit = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120).optional(),
  body: z.string().trim().min(1).max(3000),
  authorName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
});
const moderate = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PENDING"]),
  moderationNote: z.string().max(500).nullable().optional(),
});
const bulk = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(["approve", "reject", "delete"]),
  moderationNote: z.string().max(500).optional(),
});

const SORTS: Record<string, Prisma.ReviewOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }],
  oldest: [{ createdAt: "asc" }],
  highest: [{ rating: "desc" }, { createdAt: "desc" }],
  lowest: [{ rating: "asc" }, { createdAt: "desc" }],
};

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");

  async function publishedProduct(slug: string) {
    const product = await p.product.findFirst({
      where: { slug, ...publishedWhere() },
      select: { id: true, slug: true },
    });
    if (!product) throw AppError.notFound("Product");
    return product;
  }
  async function reviewsEnabled() {
    const f = (await getSettings(ctx)).features as { reviews?: boolean } | null;
    return f?.reviews !== false;
  }

  const pub = Router();
  pub.get(
    "/products/:slug/reviews",
    limiters.publicRead,
    h(async (req, res) => {
      const product = await publishedProduct(String(req.params.slug));
      const pg = clampPage(req.query.page, req.query.pageSize, 10);
      const where = { productId: product.id, status: "APPROVED" as const };
      const sort = SORTS[String(req.query.sort)] ?? SORTS.newest!;
      const [rows, total, agg] = await Promise.all([
        p.review.findMany({
          where,
          orderBy: sort,
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
          select: {
            id: true,
            authorName: true,
            rating: true,
            title: true,
            body: true,
            verifiedPurchase: true,
            createdAt: true,
          },
        }),
        p.review.count({ where }),
        getRatingAggregates(p, [product.id]),
      ]);
      res.json({ ...paginated(rows, total, pg), aggregate: agg.get(product.id) });
    }),
  );

  pub.post(
    "/products/:slug/reviews",
    limiters.write,
    h(async (req, res) => {
      if (!(await reviewsEnabled())) throw AppError.notFound("Reviews");
      const product = await publishedProduct(String(req.params.slug));
      const body = parse(submit, req.body);
      const email = body.email.toLowerCase();
      const clean = {
        authorName: stripHtml(body.authorName),
        title: body.title ? stripHtml(body.title) : null,
        body: stripHtml(body.body),
      };
      if (!clean.authorName || !clean.body)
        throw AppError.validation("Invalid request", [
          { path: "body", message: "cannot be empty" },
        ]);
      const dup = await p.review.findFirst({
        where: { productId: product.id, authorEmail: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (dup) throw AppError.conflict("You have already reviewed this product");
      const verified = await p.order.findFirst({
        where: {
          email: { equals: email, mode: "insensitive" },
          status: { not: "CANCELLED" },
          items: { some: { productId: product.id } },
        },
        select: { id: true },
      });
      const review = await p.review.create({
        data: {
          productId: product.id,
          authorEmail: email,
          rating: body.rating,
          status: "PENDING",
          verifiedPurchase: !!verified,
          ...clean,
        },
        select: { id: true, status: true, rating: true, verifiedPurchase: true },
      });
      res
        .status(201)
        .json({ ...review, message: "Thanks! Your review will appear once approved." });
    }),
  );

  // ───────── admin ─────────
  const admin = Router();
  const read = requirePermission("reviews.read");
  const mod = requirePermission("reviews.moderate");

  admin.get(
    "/reviews",
    read,
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const status = ["PENDING", "APPROVED", "REJECTED"].includes(String(req.query.status))
        ? (req.query.status as "PENDING" | "APPROVED" | "REJECTED")
        : undefined;
      const rating = Number(req.query.rating);
      const where: Prisma.ReviewWhereInput = {
        ...(status ? { status } : {}),
        ...(typeof req.query.productId === "string" ? { productId: req.query.productId } : {}),
        ...(rating >= 1 && rating <= 5 ? { rating } : {}),
        ...(q
          ? {
              OR: [
                { authorName: { contains: q, mode: "insensitive" } },
                { authorEmail: { contains: q, mode: "insensitive" } },
                { title: { contains: q, mode: "insensitive" } },
                { body: { contains: q, mode: "insensitive" } },
                { product: { title: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        p.review.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
          include: { product: { select: { id: true, title: true, slug: true } } },
        }),
        p.review.count({ where }),
      ]);
      res.json(paginated(items, total, pg));
    }),
  );

  admin.post(
    "/reviews/bulk",
    mod,
    h(async (req, res) => {
      const b = parse(bulk, req.body);
      let affected: number;
      if (b.action === "delete") {
        affected = (await p.review.deleteMany({ where: { id: { in: b.ids } } })).count;
      } else {
        affected = (
          await p.review.updateMany({
            where: { id: { in: b.ids } },
            data: {
              status: b.action === "approve" ? "APPROVED" : "REJECTED",
              moderatedAt: new Date(),
              ...(b.moderationNote !== undefined ? { moderationNote: b.moderationNote } : {}),
            },
          })
        ).count;
      }
      await audit(ctx, req, {
        action: `review.bulk.${b.action}`,
        entityType: "Review",
        extra: { ids: b.ids, affected },
      });
      res.json({ affected });
    }),
  );

  admin.patch(
    "/reviews/:id/moderate",
    mod,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(moderate, req.body);
      const before = await p.review.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Review");
      const review = await p.review.update({
        where: { id },
        data: {
          status: b.status,
          moderatedAt: new Date(),
          ...(b.moderationNote !== undefined ? { moderationNote: b.moderationNote } : {}),
        },
      });
      await audit(ctx, req, {
        action: "review.moderate",
        entityType: "Review",
        entityId: id,
        before: { status: before.status },
        after: { status: review.status, note: review.moderationNote },
      });
      res.json(review);
    }),
  );

  admin.delete(
    "/reviews/:id",
    mod,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const before = await p.review.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Review");
      await p.review.delete({ where: { id } });
      await audit(ctx, req, {
        action: "review.delete",
        entityType: "Review",
        entityId: id,
        before: { status: before.status, productId: before.productId },
      });
      res.status(204).end();
    }),
  );

  return { public: pub, admin };
}
