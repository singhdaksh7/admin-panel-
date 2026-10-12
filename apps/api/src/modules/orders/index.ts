import { Router } from "express";
import { z } from "zod";
import type { OrderStatus, PaymentStatus, Prisma } from "@kash-commerce/database";
import { AppError, clampPage, paginated } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { safeEqual } from "../../lib/crypto";
import { requirePermission } from "../../middleware/adminAuth";
import { customerAuth } from "../../middleware/customerAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { publicOrderDto, publicOrderInclude } from "./dto";
import { cancelOrder, transitionOrder } from "./service";

const STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "PACKED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "RETURN_REQUESTED",
  "RETURNED",
  "REFUNDED",
] as const;
const PAY_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "PAID",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  paymentStatus: z.enum(PAY_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(["createdAt", "total", "orderNumber"]).default("createdAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
const statusBody = z.object({
  status: z.enum(STATUSES),
  note: z.string().trim().max(500).optional(),
});
const noteBody = z.object({ body: z.string().trim().min(1).max(2000) });
const cancelBody = z.object({ reason: z.string().trim().max(500).optional() });

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const pub = Router();
  const admin = Router();

  // ───────── public lookup: owning customer session OR orderNumber + matching email ─────────
  pub.get(
    "/orders/:orderNumber",
    limiters.checkout,
    customerAuth(ctx, { required: false }),
    h(async (req, res) => {
      const orderNumber = String(req.params.orderNumber).slice(0, 40);
      const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
      const o = await p.order.findUnique({ where: { orderNumber }, include: publicOrderInclude });
      // always run the same comparisons so existence is not observable via timing/shape
      const emailOk = safeEqual(
        (o?.email ?? "\u0000not-an-email").toLowerCase(),
        email || "\u0001",
      );
      const owner = !!o && !!req.customer && o.customerId === req.customer.id;
      if (!o || !(owner || emailOk)) throw AppError.notFound("Order");
      res.json(publicOrderDto(o));
    }),
  );

  // ───────── admin ─────────
  admin.get(
    "/orders",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const q = parse(listQuery, req.query);
      const and: Prisma.OrderWhereInput[] = [];
      if (q.status) and.push({ status: q.status as OrderStatus });
      if (q.paymentStatus) and.push({ paymentStatus: q.paymentStatus as PaymentStatus });
      if (q.from || q.to)
        and.push({
          createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) },
        });
      if (q.q) {
        const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
        const byName = await p.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Order" WHERE "customerSnapshot"->>'name' ILIKE ${like} LIMIT 500`;
        and.push({
          OR: [
            { orderNumber: { contains: q.q, mode: "insensitive" } },
            { email: { contains: q.q, mode: "insensitive" } },
            { id: { in: byName.map((r) => r.id) } },
          ],
        });
      }
      const where: Prisma.OrderWhereInput = and.length ? { AND: and } : {};
      const [rows, total] = await Promise.all([
        p.order.findMany({
          where,
          orderBy: { [q.sort]: q.dir },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { _count: { select: { items: true } } },
        }),
        p.order.count({ where }),
      ]);
      res.json(
        paginated(
          rows.map((o) => ({
            id: o.id,
            orderNumber: o.orderNumber,
            status: o.status,
            paymentStatus: o.paymentStatus,
            email: o.email,
            customer: (o.customerSnapshot as { name?: string } | null)?.name ?? null,
            total: o.total.toFixed(2),
            currency: o.currency,
            itemCount: o._count.items,
            createdAt: o.createdAt,
          })),
          total,
          { page, pageSize },
        ),
      );
    }),
  );

  admin.get(
    "/orders/:id",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const o = await p.order.findFirst({
        where: { OR: [{ id }, { orderNumber: id }] },
        include: {
          items: { orderBy: { id: "asc" } },
          events: { orderBy: { createdAt: "asc" } },
          notes: { orderBy: { createdAt: "asc" } },
          payments: { orderBy: { createdAt: "asc" } },
          shipments: { orderBy: { createdAt: "asc" } },
          invoice: true,
          customer: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      });
      if (!o) throw AppError.notFound("Order");
      res.json({
        ...o,
        subtotal: o.subtotal.toFixed(2),
        discountTotal: o.discountTotal.toFixed(2),
        shippingTotal: o.shippingTotal.toFixed(2),
        taxTotal: o.taxTotal.toFixed(2),
        total: o.total.toFixed(2),
        items: o.items.map((i) => ({
          ...i,
          unitPrice: i.unitPrice.toFixed(2),
          discount: i.discount.toFixed(2),
          taxRate: i.taxRate.toString(),
          taxAmount: i.taxAmount.toFixed(2),
          lineTotal: i.lineTotal.toFixed(2),
        })),
        payments: o.payments.map((x) => ({
          ...x,
          amount: x.amount.toFixed(2),
          refundedAmount: x.refundedAmount.toFixed(2),
        })),
        invoice: o.invoice ?? { status: "NOT_GENERATED" },
      });
    }),
  );

  admin.post(
    "/orders/:id/status",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(statusBody, req.body);
      const before = await p.order.findUnique({ where: { id }, select: { status: true } });
      if (!before) throw AppError.notFound("Order");
      const o = await transitionOrder(
        ctx,
        id,
        b.status,
        { type: "ADMIN", id: req.admin!.id },
        b.note,
      );
      await audit(ctx, req, {
        action: "order.status",
        entityType: "Order",
        entityId: id,
        before: { status: before.status },
        after: { status: o.status },
        extra: { note: b.note },
      });
      res.json({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
      });
    }),
  );

  admin.post(
    "/orders/:id/cancel",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(cancelBody, req.body ?? {});
      const o = await cancelOrder(ctx, id, { type: "ADMIN", id: req.admin!.id }, b.reason);
      await audit(ctx, req, {
        action: "order.cancel",
        entityType: "Order",
        entityId: id,
        extra: { reason: b.reason },
      });
      res.json({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
      });
    }),
  );

  admin.post(
    "/orders/:id/notes",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(noteBody, req.body);
      if (!(await p.order.findUnique({ where: { id }, select: { id: true } })))
        throw AppError.notFound("Order");
      const note = await p.$transaction(async (tx) => {
        const n = await tx.orderNote.create({
          data: { orderId: id, authorId: req.admin!.id, body: b.body },
        });
        await tx.orderEvent.create({
          data: {
            orderId: id,
            type: "NOTE",
            message: b.body.slice(0, 200),
            actorType: "ADMIN",
            actorId: req.admin!.id,
          },
        });
        return n;
      });
      await audit(ctx, req, { action: "order.note", entityType: "Order", entityId: id });
      res.status(201).json(note);
    }),
  );

  // ───────── dashboard ─────────
  admin.get(
    "/dashboard/summary",
    requirePermission("dashboard.read"),
    h(async (_req, res) => {
      const now = new Date();
      const startOfDay = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const d7 = new Date(now.getTime() - 7 * 86400_000);
      const d30 = new Date(now.getTime() - 30 * 86400_000);
      const paid = (since: Date) =>
        p.order.aggregate({
          where: {
            paymentStatus: "PAID",
            status: { notIn: ["CANCELLED", "REFUNDED"] },
            placedAt: { gte: since },
          },
          _sum: { total: true },
          _count: true,
        });
      const [today, week, month, byStatus, recent, lowStock, top, pendingUnpaid, settings] =
        await Promise.all([
          paid(startOfDay),
          paid(d7),
          paid(d30),
          p.order.groupBy({ by: ["status"], _count: { _all: true } }),
          p.order.findMany({
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
              id: true,
              orderNumber: true,
              status: true,
              paymentStatus: true,
              total: true,
              currency: true,
              email: true,
              createdAt: true,
            },
          }),
          p.$queryRaw<
            {
              variantId: string;
              sku: string;
              productTitle: string;
              onHand: number;
              reserved: number;
              lowStockThreshold: number;
            }[]
          >`SELECT i."variantId", v."sku", pr."title" AS "productTitle", i."onHand", i."reserved", i."lowStockThreshold"
          FROM "InventoryItem" i
          JOIN "ProductVariant" v ON v."id" = i."variantId"
          JOIN "Product" pr ON pr."id" = v."productId"
          WHERE i."trackInventory" AND v."isActive" AND (i."onHand" - i."reserved") <= i."lowStockThreshold"
          ORDER BY (i."onHand" - i."reserved") ASC LIMIT 20`,
          p.$queryRaw<
            { productId: string | null; title: string; quantity: bigint; revenue: string }[]
          >`
          SELECT oi."productId", MAX(oi."productTitle") AS "title", SUM(oi."quantity") AS "quantity",
                 SUM(oi."lineTotal")::text AS "revenue"
          FROM "OrderItem" oi JOIN "Order" o ON o."id" = oi."orderId"
          WHERE o."status" NOT IN ('CANCELLED','REFUNDED','PENDING') AND o."placedAt" >= ${d30}
          GROUP BY oi."productId", oi."productTitle" ORDER BY SUM(oi."quantity") DESC LIMIT 5`,
          p.order.count({
            where: {
              status: "PENDING",
              paymentStatus: "PENDING",
              createdAt: { lt: new Date(now.getTime() - 30 * 60_000) },
            },
          }),
          p.storeSettings.findUnique({ where: { id: "store" } }),
        ]);
      const sum = (a: { _sum: { total: Prisma.Decimal | null }; _count: number }) => ({
        revenue: (a._sum.total ?? 0).toFixed(2),
        orders: a._count,
      });
      const outOfStock = lowStock.filter((l) => l.onHand - l.reserved <= 0).length;
      res.json({
        currency: settings?.currency ?? "USD",
        revenue: { today: sum(today), last7Days: sum(week), last30Days: sum(month) },
        ordersByStatus: Object.fromEntries(
          STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?._count._all ?? 0]),
        ),
        lowStock: lowStock.map((l) => ({ ...l, available: l.onHand - l.reserved })),
        topProducts: top.map((t) => ({
          productId: t.productId,
          title: t.title,
          quantity: Number(t.quantity),
          revenue: t.revenue,
        })),
        recentOrders: recent.map((o) => ({ ...o, total: o.total.toFixed(2) })),
        alerts: {
          pendingUnpaidOrders: pendingUnpaid,
          lowStockVariants: lowStock.length,
          outOfStockVariants: outOfStock,
        },
      });
    }),
  );

  return { public: pub, admin };
}
