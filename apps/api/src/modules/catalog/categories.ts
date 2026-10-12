import { Router } from "express";
import { z } from "zod";
import { AppError } from "@kash-commerce/shared";
import { Prisma, type Category } from "@kash-commerce/database";
import type { AppContext } from "../../context";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { missingMediaIds } from "../media/service";
import { isUniqueViolation, seoSchema, slugSchema, uniqueSlug } from "./common";

const nullableId = z.string().min(1).max(64).nullable();

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  parentId: nullableId.optional(),
  description: z.string().max(5000).nullable().optional(),
  imageMediaId: nullableId.optional(),
  bannerMediaId: nullableId.optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
  isActive: z.boolean().optional(),
  seo: seoSchema.nullable().optional(),
});
const updateBody = createBody.partial();
const reorderBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        sortOrder: z.number().int(),
        parentId: nullableId.optional(),
      }),
    )
    .min(1)
    .max(500),
});

export interface CategoryNode extends Category {
  productCount: number;
  children: CategoryNode[];
}

export function buildTree(rows: (Category & { _count: { products: number } })[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const r of rows) {
    const { _count, ...rest } = r;
    nodes.set(r.id, { ...rest, productCount: _count.products, children: [] });
  }
  const roots: CategoryNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (list: CategoryNode[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    list.forEach((c) => sort(c.children));
  };
  sort(roots);
  return roots;
}

export function registerCategories(ctx: AppContext, admin: Router) {
  const p = ctx.prisma;

  /** Would making `parentId` the parent of `id` create a cycle? */
  async function wouldCycle(id: string, parentId: string): Promise<boolean> {
    if (parentId === id) return true;
    const all = await p.category.findMany({ select: { id: true, parentId: true } });
    const parentOf = new Map(all.map((c) => [c.id, c.parentId]));
    let cur: string | null | undefined = parentId;
    for (let i = 0; cur && i <= all.length; i++) {
      if (cur === id) return true;
      cur = parentOf.get(cur);
    }
    return false;
  }

  async function checkRefs(body: z.infer<typeof updateBody>, selfId?: string) {
    if (body.parentId) {
      if (!(await p.category.findUnique({ where: { id: body.parentId }, select: { id: true } })))
        throw AppError.validation("Parent category not found");
      if (selfId && (await wouldCycle(selfId, body.parentId)))
        throw AppError.validation("A category cannot be moved under itself or its descendants");
    }
    const media = [body.imageMediaId, body.bannerMediaId].filter((x): x is string => !!x);
    const missing = await missingMediaIds(p, media);
    if (missing.length) throw AppError.validation("Unknown media id", { missing });
  }

  admin.get(
    "/categories",
    requirePermission("categories.read"),
    h(async (req, res) => {
      const rows = await p.category.findMany({
        include: { _count: { select: { products: true } } },
      });
      if (req.query.flat === "true") {
        res.json({
          items: rows
            .map(({ _count, ...c }) => ({ ...c, productCount: _count.products }))
            .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
        });
        return;
      }
      res.json({ items: buildTree(rows) });
    }),
  );

  admin.get(
    "/categories/:id",
    requirePermission("categories.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const c = await p.category.findUnique({
        where: { id },
        include: { _count: { select: { products: true, children: true } } },
      });
      if (!c) throw AppError.notFound("Category");
      res.json(c);
    }),
  );

  admin.post(
    "/categories",
    requirePermission("categories.write"),
    h(async (req, res) => {
      const body = parse(createBody, req.body);
      await checkRefs(body);
      if (body.slug && (await p.category.findUnique({ where: { slug: body.slug } })))
        throw AppError.conflict("Slug already in use");
      const slug =
        body.slug ??
        (await uniqueSlug(
          async (s) =>
            !!(await p.category.findUnique({ where: { slug: s }, select: { id: true } })),
          body.name,
        ));
      try {
        const created = await p.category.create({
          data: {
            name: body.name,
            slug,
            parentId: body.parentId ?? null,
            description: body.description ?? null,
            imageMediaId: body.imageMediaId ?? null,
            bannerMediaId: body.bannerMediaId ?? null,
            sortOrder: body.sortOrder ?? 0,
            isActive: body.isActive ?? true,
            seo: (body.seo ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });
        await audit(ctx, req, {
          action: "category.create",
          entityType: "Category",
          entityId: created.id,
          after: { name: created.name, slug, parentId: created.parentId },
        });
        res.status(201).json(created);
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("Slug already in use");
        throw err;
      }
    }),
  );

  admin.post(
    "/categories/reorder",
    requirePermission("categories.write"),
    h(async (req, res) => {
      const body = parse(reorderBody, req.body);
      const ids = body.items.map((i) => i.id);
      const found = await p.category.findMany({ where: { id: { in: ids } }, select: { id: true } });
      if (found.length !== new Set(ids).size) throw AppError.validation("Unknown category id");
      for (const it of body.items) {
        if (it.parentId) {
          if (!(await p.category.findUnique({ where: { id: it.parentId }, select: { id: true } })))
            throw AppError.validation("Parent category not found");
          if (await wouldCycle(it.id, it.parentId))
            throw AppError.validation("Reorder would create a cycle");
        }
      }
      await p.$transaction(
        body.items.map((it) =>
          p.category.update({
            where: { id: it.id },
            data: {
              sortOrder: it.sortOrder,
              ...(it.parentId !== undefined ? { parentId: it.parentId } : {}),
            },
          }),
        ),
      );
      await audit(ctx, req, {
        action: "category.reorder",
        entityType: "Category",
        extra: { count: body.items.length },
      });
      res.json({ ok: true });
    }),
  );

  admin.patch(
    "/categories/:id",
    requirePermission("categories.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(updateBody, req.body);
      const before = await p.category.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Category");
      await checkRefs(body, id);
      if (body.slug && body.slug !== before.slug) {
        if (await p.category.findUnique({ where: { slug: body.slug } }))
          throw AppError.conflict("Slug already in use");
      }
      try {
        const after = await p.category.update({
          where: { id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.slug !== undefined ? { slug: body.slug } : {}),
            ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.imageMediaId !== undefined ? { imageMediaId: body.imageMediaId } : {}),
            ...(body.bannerMediaId !== undefined ? { bannerMediaId: body.bannerMediaId } : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            ...(body.seo !== undefined
              ? { seo: (body.seo ?? Prisma.DbNull) as Prisma.InputJsonValue }
              : {}),
          },
        });
        await audit(ctx, req, {
          action: "category.update",
          entityType: "Category",
          entityId: id,
          before,
          after: body,
        });
        res.json(after);
      } catch (err) {
        if (isUniqueViolation(err)) throw AppError.conflict("Slug already in use");
        throw err;
      }
    }),
  );

  admin.delete(
    "/categories/:id",
    requirePermission("categories.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const cat = await p.category.findUnique({
        where: { id },
        include: { _count: { select: { products: true, children: true } } },
      });
      if (!cat) throw AppError.notFound("Category");
      if (cat._count.children > 0)
        throw AppError.conflict("Category has child categories; move or delete them first");
      const reassign = typeof req.query.reassignTo === "string" ? req.query.reassignTo : undefined;
      if (cat._count.products > 0 && !reassign)
        throw AppError.conflict(
          "Category has products; pass ?reassignTo=<categoryId|none> to move them",
          { productCount: cat._count.products },
        );
      let target: string | null = null;
      if (reassign && reassign !== "none") {
        if (reassign === id) throw AppError.validation("Cannot reassign to the deleted category");
        if (!(await p.category.findUnique({ where: { id: reassign }, select: { id: true } })))
          throw AppError.validation("Reassign target not found");
        target = reassign;
      }
      await p.$transaction(async (tx) => {
        if (cat._count.products > 0)
          await tx.product.updateMany({ where: { categoryId: id }, data: { categoryId: target } });
        await tx.category.delete({ where: { id } });
      });
      await audit(ctx, req, {
        action: "category.delete",
        entityType: "Category",
        entityId: id,
        before: { name: cat.name, slug: cat.slug },
        extra: { reassignedTo: target, moved: cat._count.products },
      });
      res.status(204).end();
    }),
  );
}
