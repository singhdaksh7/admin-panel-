import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@kash-commerce/database";
import { AppError, clampPage, paginated } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { adjustStock, availableQuantity } from "./service";

const variantParam = z.object({ variantId: z.string().min(1).max(64) });
const adjustBody = z
  .object({
    delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    set: z.number().int().min(0).max(10_000_000).optional(),
    reason: z.string().trim().min(1).max(300),
    lowStockThreshold: z.number().int().min(0).max(1_000_000).optional(),
    trackInventory: z.boolean().optional(),
    allowBackorder: z.boolean().optional(),
  })
  .refine((b) => !(b.delta !== undefined && b.set !== undefined), {
    message: "Provide either delta or set, not both",
  })
  .refine(
    (b) =>
      b.delta !== undefined ||
      b.set !== undefined ||
      b.lowStockThreshold !== undefined ||
      b.trackInventory !== undefined ||
      b.allowBackorder !== undefined,
    { message: "Nothing to change" },
  );

const itemInclude = {
  variant: {
    select: {
      id: true,
      sku: true,
      title: true,
      isActive: true,
      product: { select: { id: true, title: true, slug: true } },
    },
  },
} as const;

type ItemWithVariant = Prisma.InventoryItemGetPayload<{ include: typeof itemInclude }>;

function present(i: ItemWithVariant) {
  return {
    id: i.id,
    variantId: i.variantId,
    sku: i.variant.sku,
    variantTitle: i.variant.title,
    productId: i.variant.product.id,
    productTitle: i.variant.product.title,
    productSlug: i.variant.product.slug,
    onHand: i.onHand,
    reserved: i.reserved,
    available: availableQuantity(i),
    lowStockThreshold: i.lowStockThreshold,
    trackInventory: i.trackInventory,
    allowBackorder: i.allowBackorder,
    isLow: i.trackInventory && availableQuantity(i) <= i.lowStockThreshold,
    updatedAt: i.updatedAt,
  };
}

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const admin = Router();

  const lowStockIds = async (): Promise<string[]> => {
    const rows = await p.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "InventoryItem"
       WHERE "trackInventory" = true AND ("onHand" - "reserved") <= "lowStockThreshold"`;
    return rows.map((r) => r.id);
  };

  const listItems = async (
    query: Record<string, unknown>,
    forceLow: boolean,
  ): Promise<ReturnType<typeof paginated<ReturnType<typeof present>>>> => {
    const pg = clampPage(query.page, query.pageSize);
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
    const and: Prisma.InventoryItemWhereInput[] = [];
    if (q)
      and.push({
        OR: [
          { variant: { sku: { contains: q, mode: "insensitive" } } },
          { variant: { product: { title: { contains: q, mode: "insensitive" } } } },
        ],
      });
    if (forceLow || query.lowStock === "true" || query.lowStock === "1")
      and.push({ id: { in: await lowStockIds() } });
    const where: Prisma.InventoryItemWhereInput = and.length ? { AND: and } : {};
    const [items, total] = await Promise.all([
      p.inventoryItem.findMany({
        where,
        include: itemInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (pg.page - 1) * pg.pageSize,
        take: pg.pageSize,
      }),
      p.inventoryItem.count({ where }),
    ]);
    return paginated(items.map(present), total, pg);
  };

  admin.get(
    "/inventory",
    requirePermission("inventory.read"),
    h(async (req, res) => {
      res.json(await listItems(req.query, false));
    }),
  );

  admin.get(
    "/inventory/low-stock",
    requirePermission("inventory.read"),
    h(async (req, res) => {
      res.json(await listItems(req.query, true));
    }),
  );

  admin.get(
    "/inventory/:variantId",
    requirePermission("inventory.read"),
    h(async (req, res) => {
      const { variantId } = parse(variantParam, req.params);
      const item = await p.inventoryItem.findUnique({ where: { variantId }, include: itemInclude });
      if (!item) throw AppError.notFound("Inventory item");
      res.json(present(item));
    }),
  );

  admin.get(
    "/inventory/:variantId/movements",
    requirePermission("inventory.read"),
    h(async (req, res) => {
      const { variantId } = parse(variantParam, req.params);
      const item = await p.inventoryItem.findUnique({ where: { variantId } });
      if (!item) throw AppError.notFound("Inventory item");
      const pg = clampPage(req.query.page, req.query.pageSize, 50);
      const [items, total] = await Promise.all([
        p.inventoryMovement.findMany({
          where: { itemId: item.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
        }),
        p.inventoryMovement.count({ where: { itemId: item.id } }),
      ]);
      res.json(paginated(items, total, pg));
    }),
  );

  admin.patch(
    "/inventory/:variantId",
    requirePermission("inventory.write"),
    h(async (req, res) => {
      const { variantId } = parse(variantParam, req.params);
      const body = parse(adjustBody, req.body);
      const variant = await p.productVariant.findUnique({
        where: { id: variantId },
        select: { id: true },
      });
      if (!variant) throw AppError.notFound("Variant");
      const settings: Prisma.InventoryItemUpdateInput = {
        ...(body.lowStockThreshold !== undefined
          ? { lowStockThreshold: body.lowStockThreshold }
          : {}),
        ...(body.trackInventory !== undefined ? { trackInventory: body.trackInventory } : {}),
        ...(body.allowBackorder !== undefined ? { allowBackorder: body.allowBackorder } : {}),
      };
      await p.$transaction(async (tx) => {
        if (Object.keys(settings).length)
          await tx.inventoryItem.upsert({
            where: { variantId },
            create: { ...(settings as Prisma.InventoryItemUncheckedCreateInput), variantId },
            update: settings,
          });
        if (body.delta !== undefined || body.set !== undefined)
          await adjustStock(tx, variantId, {
            delta: body.delta,
            set: body.set,
            reason: body.reason,
            actorId: req.admin!.id,
          });
      });
      const item = await p.inventoryItem.findUniqueOrThrow({
        where: { variantId },
        include: itemInclude,
      });
      await audit(ctx, req, {
        action: "inventory.adjust",
        entityType: "InventoryItem",
        entityId: item.id,
        after: { ...body, variantId, onHand: item.onHand },
      });
      res.json(present(item));
    }),
  );

  return { admin };
}
