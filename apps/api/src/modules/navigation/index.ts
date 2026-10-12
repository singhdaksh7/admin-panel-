import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@kash-commerce/database";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { isPublishedNow, mediaUrlMap } from "../content/resolve";

/**
 * NavigationItem.promo JSON = { title, subtitle?, mediaId?, url, ctaLabel?, _autoChildren?: boolean }.
 * `_autoChildren` (CATEGORY items only) means "children = the category's active subcategories"; it is
 * exposed in the admin API as the boolean field `autoChildren` and kept inside `promo` because the
 * schema is frozen.
 */
export const MAX_DEPTH = 4;
export const MAX_ITEMS = 500;
const TYPES = ["LINK", "CATEGORY", "COLLECTION", "PAGE", "MEGA"] as const;

const safeUrl = z
  .string()
  .min(1)
  .max(1000)
  .refine((u) => /^(\/(?!\/)|https?:\/\/|mailto:|tel:|#)/i.test(u), {
    message: "must be a relative path (/...), http(s) URL, mailto: or tel:",
  });

const promoSchema = z
  .object({
    title: z.string().min(1).max(120),
    subtitle: z.string().max(200).optional(),
    mediaId: z.string().min(1).max(64).optional(),
    url: safeUrl,
    ctaLabel: z.string().max(60).optional(),
  })
  .strict();

interface ItemInput {
  id?: string;
  label: string;
  type: (typeof TYPES)[number];
  url?: string | null;
  categoryId?: string | null;
  categorySlug?: string;
  collectionId?: string | null;
  collectionSlug?: string;
  pageSlug?: string | null;
  badge?: string | null;
  promo?: z.infer<typeof promoSchema> | null;
  autoChildren?: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  openInNewTab: boolean;
  active: boolean;
  sortOrder?: number;
  children?: ItemInput[];
}

const itemSchema: z.ZodType<ItemInput, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(64).optional(),
      label: z.string().min(1).max(120),
      type: z.enum(TYPES).default("LINK"),
      url: safeUrl.nullable().optional(),
      categoryId: z.string().max(64).nullable().optional(),
      categorySlug: z.string().max(160).optional(),
      collectionId: z.string().max(64).nullable().optional(),
      collectionSlug: z.string().max(160).optional(),
      pageSlug: z.string().max(160).nullable().optional(),
      badge: z.string().max(30).nullable().optional(),
      promo: promoSchema.nullable().optional(),
      autoChildren: z.boolean().optional(),
      showDesktop: z.boolean().default(true),
      showMobile: z.boolean().default(true),
      openInNewTab: z.boolean().default(false),
      active: z.boolean().default(true),
      sortOrder: z.number().int().optional(),
      children: z.array(itemSchema).max(100).optional(),
    })
    .strict(),
);

const treeBody = z.object({
  name: z.string().min(1).max(80).optional(),
  items: z.array(itemSchema).max(100),
});

interface FlatItem {
  id: string;
  parentId: string | null;
  data: Prisma.NavigationItemUncheckedCreateInput;
}

type DbItem = Prisma.NavigationItemGetPayload<object>;

function adminShape(i: DbItem, children: unknown[]) {
  const promo = (i.promo ?? null) as Record<string, unknown> | null;
  const { _autoChildren, ...promoRest } = promo ?? {};
  return {
    id: i.id,
    label: i.label,
    type: i.type,
    url: i.url,
    categoryId: i.categoryId,
    collectionId: i.collectionId,
    pageSlug: i.pageSlug,
    badge: i.badge,
    promo: promo ? promoRest : null,
    autoChildren: _autoChildren === true,
    showDesktop: i.showDesktop,
    showMobile: i.showMobile,
    openInNewTab: i.openInNewTab,
    active: i.isActive,
    sortOrder: i.sortOrder,
    children,
  };
}

function buildTree(items: DbItem[]) {
  const byParent = new Map<string | null, DbItem[]>();
  for (const i of items) {
    byParent.set(i.parentId, [...(byParent.get(i.parentId) ?? []), i]);
  }
  const walk = (parent: string | null): unknown[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
      .map((i) => adminShape(i, walk(i.id)));
  return walk(null);
}

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");

  // ───────────── public ─────────────
  const pub = Router();

  async function resolveMenu(menu: { id: string; key: string; name: string }) {
    const [items, cats, cols, pages] = await Promise.all([
      p.navigationItem.findMany({ where: { menuId: menu.id, isActive: true } }),
      p.category.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      p.collection.findMany({ where: { isActive: true } }),
      p.page.findMany({ where: { status: "PUBLISHED" } }),
    ]);
    const now = new Date();
    const catById = new Map(cats.map((c) => [c.id, c]));
    const colById = new Map(cols.map((c) => [c.id, c]));
    const pageBySlug = new Map(
      pages.filter((pg) => isPublishedNow(pg, now)).map((pg) => [pg.slug, pg]),
    );
    const media = await mediaUrlMap(
      ctx,
      items.map((i) => (i.promo as { mediaId?: string } | null)?.mediaId),
    );
    const byParent = new Map<string | null, DbItem[]>();
    for (const i of items) byParent.set(i.parentId, [...(byParent.get(i.parentId) ?? []), i]);

    interface Out {
      id: string;
      label: string;
      type: string;
      url: string | null;
      badge: string | null;
      promo: Record<string, unknown> | null;
      showDesktop: boolean;
      showMobile: boolean;
      openInNewTab: boolean;
      children: Out[];
    }

    const walk = (parent: string | null): Out[] => {
      const out: Out[] = [];
      const list = (byParent.get(parent) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const i of list) {
        let url: string | null = i.url;
        let autoKids: Out[] = [];
        if (i.type === "CATEGORY") {
          const c = i.categoryId ? catById.get(i.categoryId) : undefined;
          if (!c) continue;
          url = `/category/${c.slug}`;
          const promo = (i.promo ?? {}) as { _autoChildren?: boolean };
          if (promo._autoChildren) {
            autoKids = cats
              .filter((k) => k.parentId === c.id)
              .map((k) => ({
                id: `${i.id}:${k.id}`,
                label: k.name,
                type: "CATEGORY",
                url: `/category/${k.slug}`,
                badge: null,
                promo: null,
                showDesktop: i.showDesktop,
                showMobile: i.showMobile,
                openInNewTab: false,
                children: [],
              }));
          }
        } else if (i.type === "COLLECTION") {
          const c = i.collectionId ? colById.get(i.collectionId) : undefined;
          if (!c) continue;
          url = `/collection/${c.slug}`;
        } else if (i.type === "PAGE") {
          const pg = i.pageSlug ? pageBySlug.get(i.pageSlug) : undefined;
          if (!pg) continue;
          url = `/pages/${pg.slug}`;
        }
        const children = walk(i.id);
        const explicitUrls = new Set(children.map((c) => c.url));
        const rawPromo = i.promo as Record<string, unknown> | null;
        let promo: Record<string, unknown> | null = null;
        if (rawPromo) {
          const { _autoChildren, mediaId, ...rest } = rawPromo;
          void _autoChildren;
          if (Object.keys(rest).length)
            promo = {
              ...rest,
              ...(typeof mediaId === "string"
                ? { mediaId, mediaUrl: media.get(mediaId) ?? null }
                : {}),
            };
        }
        out.push({
          id: i.id,
          label: i.label,
          type: i.type,
          url,
          badge: i.badge,
          promo,
          showDesktop: i.showDesktop,
          showMobile: i.showMobile,
          openInNewTab: i.openInNewTab,
          children: [...children, ...autoKids.filter((k) => !explicitUrls.has(k.url))],
        });
      }
      return out;
    };
    return { key: menu.key, name: menu.name, items: walk(null) };
  }

  pub.get(
    "/navigation",
    limiters.publicRead,
    h(async (req, res) => {
      const key = typeof req.query.menu === "string" && req.query.menu ? req.query.menu : "header";
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      if (key === "all") {
        const menus = await p.navigationMenu.findMany({ orderBy: { key: "asc" } });
        return void res.json({ menus: await Promise.all(menus.map(resolveMenu)) });
      }
      const menu = await p.navigationMenu.findUnique({ where: { key } });
      // An unconfigured header/footer is an empty menu, not an error (fresh installs).
      if (!menu) {
        if (key === "header" || key === "footer")
          return void res.json({ key, name: key, items: [] });
        throw AppError.notFound("Menu");
      }
      res.json(await resolveMenu(menu));
    }),
  );

  // ───────────── admin ─────────────
  const admin = Router();
  const read = requirePermission("content.read");
  const write = requirePermission("navigation.write");

  admin.get(
    "/navigation",
    read,
    h(async (_req, res) => {
      const menus = await p.navigationMenu.findMany({
        orderBy: { key: "asc" },
        include: { _count: { select: { items: true } } },
      });
      res.json({
        items: menus.map((m) => ({
          id: m.id,
          key: m.key,
          name: m.name,
          itemCount: m._count.items,
        })),
      });
    }),
  );

  admin.get(
    "/navigation/:key",
    read,
    h(async (req, res) => {
      const menu = await p.navigationMenu.findUnique({
        where: { key: String(req.params.key) },
        include: { items: true },
      });
      if (!menu) throw AppError.notFound("Menu");
      res.json({ id: menu.id, key: menu.key, name: menu.name, items: buildTree(menu.items) });
    }),
  );

  admin.put(
    "/navigation/:key",
    write,
    h(async (req, res) => {
      const key = String(req.params.key);
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(key))
        throw AppError.validation("Menu key must be lowercase letters, digits, - or _");
      const body = parse(treeBody, req.body);

      // Resolve slugs -> ids and collect lookups in bulk
      const catSlugs = new Set<string>();
      const colSlugs = new Set<string>();
      const catIds = new Set<string>();
      const colIds = new Set<string>();
      const walkCollect = (items: ItemInput[]) => {
        for (const i of items) {
          if (i.categorySlug) catSlugs.add(i.categorySlug);
          if (i.collectionSlug) colSlugs.add(i.collectionSlug);
          if (i.categoryId) catIds.add(i.categoryId);
          if (i.collectionId) colIds.add(i.collectionId);
          walkCollect(i.children ?? []);
        }
      };
      walkCollect(body.items);
      const [cats, cols] = await Promise.all([
        p.category.findMany({
          where: { OR: [{ slug: { in: [...catSlugs] } }, { id: { in: [...catIds] } }] },
          select: { id: true, slug: true },
        }),
        p.collection.findMany({
          where: { OR: [{ slug: { in: [...colSlugs] } }, { id: { in: [...colIds] } }] },
          select: { id: true, slug: true },
        }),
      ]);
      const catBySlug = new Map(cats.map((c) => [c.slug, c.id]));
      const colBySlug = new Map(cols.map((c) => [c.slug, c.id]));
      const catIdSet = new Set(cats.map((c) => c.id));
      const colIdSet = new Set(cols.map((c) => c.id));

      const errors: { path: string; message: string }[] = [];
      const flat: FlatItem[] = [];
      const seen = new Set<string>();

      const visit = (items: ItemInput[], parentId: string | null, depth: number, path: string) => {
        items.forEach((i, idx) => {
          const at = `${path}[${idx}]`;
          if (depth > MAX_DEPTH) {
            errors.push({ path: at, message: `nesting deeper than ${MAX_DEPTH} levels` });
            return;
          }
          const id = i.id ?? `nav_${randomBytes(9).toString("hex")}`;
          if (seen.has(id))
            errors.push({ path: `${at}.id`, message: "duplicate or cyclic item id" });
          seen.add(id);
          if (parentId === id)
            errors.push({ path: `${at}.id`, message: "item cannot be its own parent" });

          let categoryId: string | null = null;
          let collectionId: string | null = null;
          let pageSlug: string | null = null;
          let url: string | null = null;
          switch (i.type) {
            case "LINK":
              if (!i.url) errors.push({ path: `${at}.url`, message: "url is required for LINK" });
              url = i.url ?? null;
              break;
            case "MEGA":
              url = i.url ?? null;
              break;
            case "CATEGORY": {
              categoryId =
                i.categoryId ?? (i.categorySlug ? (catBySlug.get(i.categorySlug) ?? null) : null);
              if (!categoryId || (i.categoryId && !catIdSet.has(i.categoryId)))
                errors.push({ path: `${at}.categoryId`, message: "category not found" });
              break;
            }
            case "COLLECTION": {
              collectionId =
                i.collectionId ??
                (i.collectionSlug ? (colBySlug.get(i.collectionSlug) ?? null) : null);
              if (!collectionId || (i.collectionId && !colIdSet.has(i.collectionId)))
                errors.push({ path: `${at}.collectionId`, message: "collection not found" });
              break;
            }
            case "PAGE":
              if (!i.pageSlug)
                errors.push({ path: `${at}.pageSlug`, message: "pageSlug is required for PAGE" });
              pageSlug = i.pageSlug ?? null;
              break;
          }
          if (i.autoChildren && i.type !== "CATEGORY")
            errors.push({
              path: `${at}.autoChildren`,
              message: "autoChildren is only valid on CATEGORY items",
            });

          const promo =
            i.promo || i.autoChildren
              ? ({
                  ...(i.promo ?? {}),
                  ...(i.autoChildren ? { _autoChildren: true } : {}),
                } as Prisma.InputJsonValue)
              : Prisma.DbNull;
          flat.push({
            id,
            parentId,
            data: {
              id,
              menuId: "",
              parentId,
              label: i.label,
              type: i.type,
              url,
              categoryId,
              collectionId,
              pageSlug,
              badge: i.badge ?? null,
              promo,
              showDesktop: i.showDesktop,
              showMobile: i.showMobile,
              openInNewTab: i.openInNewTab,
              isActive: i.active,
              sortOrder: i.sortOrder ?? idx,
            },
          });
          visit(i.children ?? [], id, depth + 1, `${at}.children`);
        });
      };
      visit(body.items, null, 1, "items");
      if (flat.length > MAX_ITEMS)
        errors.push({ path: "items", message: `at most ${MAX_ITEMS} items per menu` });
      if (errors.length) throw AppError.validation("Invalid navigation tree", errors);

      // ids reused from another menu would steal its rows
      const ids = flat.map((f) => f.id);
      const menuExisting = await p.navigationMenu.findUnique({ where: { key } });
      const clash = await p.navigationItem.findMany({
        where: { id: { in: ids }, ...(menuExisting ? { menuId: { not: menuExisting.id } } : {}) },
        select: { id: true },
      });
      if (clash.length)
        throw AppError.validation("Invalid navigation tree", [
          {
            path: "items",
            message: `item id(s) belong to another menu: ${clash.map((c) => c.id).join(", ")}`,
          },
        ]);

      const before = menuExisting
        ? await p.navigationItem.count({ where: { menuId: menuExisting.id } })
        : 0;
      await p.$transaction(async (tx) => {
        const menu = await tx.navigationMenu.upsert({
          where: { key },
          create: { key, name: body.name ?? key[0]!.toUpperCase() + key.slice(1) },
          update: body.name ? { name: body.name } : {},
        });
        await tx.navigationItem.deleteMany({ where: { menuId: menu.id } });
        // parents before children so FK order holds
        for (const f of flat) {
          await tx.navigationItem.create({ data: { ...f.data, menuId: menu.id } });
        }
      });
      await audit(ctx, req, {
        action: "navigation.save",
        entityType: "NavigationMenu",
        entityId: key,
        extra: { itemsBefore: before, itemsAfter: flat.length },
      });
      const menu = await p.navigationMenu.findUniqueOrThrow({
        where: { key },
        include: { items: true },
      });
      res.json({ id: menu.id, key: menu.key, name: menu.name, items: buildTree(menu.items) });
    }),
  );

  admin.delete(
    "/navigation/:key",
    write,
    h(async (req, res) => {
      const key = String(req.params.key);
      if (key === "header" || key === "footer") {
        // built-in menus are cleared, not removed
        const m = await p.navigationMenu.findUnique({ where: { key } });
        if (m) await p.navigationItem.deleteMany({ where: { menuId: m.id } });
      } else {
        const m = await p.navigationMenu.findUnique({ where: { key } });
        if (!m) throw AppError.notFound("Menu");
        await p.navigationMenu.delete({ where: { id: m.id } });
      }
      await audit(ctx, req, {
        action: "navigation.delete",
        entityType: "NavigationMenu",
        entityId: key,
      });
      res.status(204).end();
    }),
  );

  return { public: pub, admin };
}
