import { Router } from "express";
import { z } from "zod";
import type { Order, OrderItem, Prisma, Shipment } from "@kash-commerce/database";
import { AppError } from "@kash-commerce/shared";
import type { ShipmentAddress, ShipmentItem } from "@kash-commerce/provider-sdk";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { requirePermission } from "../../middleware/adminAuth";
import { customerAuth } from "../../middleware/customerAuth";
import { transitionOrder, type Actor } from "../orders/service";
import { notify } from "../notifications/service";
import { applyIntegrationConfig } from "../integrations/service";
import { customerNameOf, loadAccessibleOrder, safeProviderMessage } from "../payments/access";

const createBody = z.object({
  provider: z.string().trim().max(40).optional(),
  carrier: z.string().trim().max(100).optional(),
  awb: z.string().trim().max(100).optional(),
  trackingUrl: z.string().trim().url().max(500).optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().trim().min(1).max(64),
        quantity: z.number().int().min(1).max(10000),
      }),
    )
    .min(1)
    .max(200)
    .optional(),
});
const patchBody = z.object({
  awb: z.string().trim().max(100).optional(),
  carrier: z.string().trim().max(100).optional(),
  trackingUrl: z.string().trim().url().max(500).nullable().optional(),
  status: z.enum(["IN_TRANSIT", "DELIVERED"]).optional(),
});

/** Stored in Shipment.trackingEvents so provider references survive restarts. */
interface TrackingBlob {
  events: { at: string; status: string; location?: string }[];
  meta: Record<string, unknown>;
  items?: { orderItemId: string; quantity: number }[];
}
const blobOf = (s: Shipment): TrackingBlob => {
  const raw = (s.trackingEvents ?? {}) as Partial<TrackingBlob>;
  return {
    events: raw.events ?? [],
    meta: raw.meta ?? {},
    ...(raw.items ? { items: raw.items } : {}),
  };
};

const ACTIVE = ["CREATING", "CREATED", "IN_TRANSIT"];

const shipmentDto = (s: Shipment) => ({
  id: s.id,
  orderId: s.orderId,
  provider: s.provider,
  providerShipmentId: s.providerShipmentId,
  awb: s.awb,
  carrier: s.carrier,
  trackingUrl: s.trackingUrl,
  status: s.status,
  error: s.error,
  events: blobOf(s).events,
  items: blobOf(s).items ?? null,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

function toAddress(o: Order): ShipmentAddress {
  const a = (o.shippingAddress ?? {}) as Record<string, string | null | undefined>;
  return {
    name: a.fullName ?? "",
    phone: a.phone ?? undefined,
    line1: a.line1 ?? "",
    line2: a.line2 ?? undefined,
    city: a.city ?? "",
    state: a.state ?? undefined,
    postalCode: a.postalCode ?? "",
    country: a.country ?? "",
  };
}

const toItem = (i: OrderItem, quantity: number): ShipmentItem => ({
  name: i.productTitle,
  sku: i.sku,
  quantity,
  unitPrice: i.unitPrice.toFixed(2),
});

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const pub = Router();
  const admin = Router();
  const opt = customerAuth(ctx, { required: false });

  const findOrder = async (idOrNumber: string) => {
    const o = await p.order.findFirst({
      where: { OR: [{ id: idOrNumber }, { orderNumber: idOrNumber }] },
      include: { items: true },
    });
    if (!o) throw AppError.notFound("Order");
    return o;
  };

  // ───────── public tracking ─────────
  pub.get(
    "/orders/:orderNumber/tracking",
    limiters.checkout,
    opt,
    h(async (req, res) => {
      const email = typeof req.query.email === "string" ? req.query.email : undefined;
      const o = await loadAccessibleOrder(p, req, String(req.params.orderNumber), email);
      const rows = await p.shipment.findMany({
        where: { orderId: o.id, status: { notIn: ["FAILED", "CREATING"] } },
        orderBy: { createdAt: "asc" },
      });
      res.json({
        orderNumber: o.orderNumber,
        orderStatus: o.status,
        shipments: rows.map((s) => ({
          carrier: s.carrier,
          awb: s.awb,
          trackingUrl: s.trackingUrl,
          status: s.status,
          events: blobOf(s).events,
        })),
      });
    }),
  );

  // ───────── admin ─────────
  admin.get(
    "/orders/:id/shipments",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const o = await findOrder(id);
      const rows = await p.shipment.findMany({
        where: { orderId: o.id },
        orderBy: { createdAt: "asc" },
      });
      res.json({ items: rows.map(shipmentDto) });
    }),
  );

  admin.get(
    "/shipments/:id",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const s = await p.shipment.findUnique({ where: { id } });
      if (!s) throw AppError.notFound("Shipment");
      res.json(shipmentDto(s));
    }),
  );

  admin.get(
    "/shipping/rates",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const orderId = typeof req.query.orderId === "string" ? req.query.orderId : "";
      if (!orderId) throw AppError.validation("orderId is required");
      const o = await findOrder(orderId);
      const key = ctx.providers.activeShipping;
      const impl = ctx.providers.shipping[key];
      if (!impl) throw AppError.notFound("Shipping provider");
      await applyIntegrationConfig(ctx, "SHIPPING", key).catch(() => undefined);
      const payments = await p.payment.findMany({ where: { orderId: o.id } });
      const cod = payments.some((x) => x.provider === "MANUAL" && x.status !== "PAID");
      try {
        const rates = await impl.getRates({
          destination: toAddress(o),
          items: o.items.map((i) => toItem(i, i.quantity)),
          subtotal: o.subtotal.toFixed(2),
          currency: o.currency,
          paymentMode: cod ? "COD" : "PREPAID",
        });
        res.json({ provider: key, rates });
      } catch (err) {
        res.json({
          provider: key,
          rates: [],
          error: safeProviderMessage(err, "Rates are unavailable right now"),
        });
      }
    }),
  );

  admin.post(
    "/orders/:id/shipments",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(createBody, req.body ?? {});
      const found = await findOrder(id);
      const providerKey = (b.provider ?? ctx.providers.activeShipping).toUpperCase();
      const impl = ctx.providers.shipping[providerKey];
      if (!impl) throw AppError.validation(`Shipping provider ${providerKey} is not available`);
      const actor: Actor = { type: "ADMIN", id: req.admin!.id };

      // validate selection against the order
      const lines: { item: OrderItem; quantity: number }[] = [];
      if (b.items) {
        const seen = new Set<string>();
        for (const it of b.items) {
          const oi = found.items.find((x) => x.id === it.orderItemId);
          if (!oi || seen.has(oi.id))
            throw AppError.validation("Invalid shipment item", { orderItemId: it.orderItemId });
          if (it.quantity > oi.quantity)
            throw AppError.validation("Shipment quantity exceeds ordered quantity", {
              orderItemId: oi.id,
            });
          seen.add(oi.id);
          lines.push({ item: oi, quantity: it.quantity });
        }
      } else for (const oi of found.items) lines.push({ item: oi, quantity: oi.quantity });

      // claim: only one in-flight/active shipment per order, and the order must be PACKED
      const claim = await p.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${found.id} FOR UPDATE`;
        const o = await tx.order.findUniqueOrThrow({ where: { id: found.id } });
        if (o.status !== "PACKED")
          throw AppError.conflict(
            ["CONFIRMED", "PROCESSING"].includes(o.status)
              ? `Order is ${o.status}; mark it PACKED before creating a shipment`
              : `Orders in status ${o.status} cannot be shipped`,
            { status: o.status },
          );
        const active = await tx.shipment.count({
          where: { orderId: o.id, status: { in: ACTIVE } },
        });
        if (active) throw AppError.conflict("This order already has an active shipment");
        return tx.shipment.create({
          data: {
            orderId: o.id,
            provider: providerKey,
            status: "CREATING",
            carrier: b.carrier ?? null,
            awb: b.awb ?? null,
            trackingUrl: b.trackingUrl ?? null,
          },
        });
      });

      await applyIntegrationConfig(ctx, "SHIPPING", providerKey).catch(() => undefined);
      const payments = await p.payment.findMany({ where: { orderId: found.id } });
      const cod = payments.some((x) => x.provider === "MANUAL" && x.status !== "PAID");
      let result;
      try {
        result = await impl.createShipment({
          orderNumber: found.orderNumber,
          destination: toAddress(found),
          items: lines.map((l) => toItem(l.item, l.quantity)),
          total: found.total.toFixed(2),
          currency: found.currency,
          paymentMode: cod ? "COD" : "PREPAID",
        });
      } catch (err) {
        ctx.logger.error({ err, orderId: found.id }, "shipment creation failed");
        const message = safeProviderMessage(
          err,
          "The shipping provider could not create the shipment",
        );
        await p.shipment.update({
          where: { id: claim.id },
          data: { status: "FAILED", error: message },
        });
        await p.orderEvent.create({
          data: {
            orderId: found.id,
            type: "SHIPMENT_FAILED",
            message,
            actorType: "ADMIN",
            actorId: req.admin!.id,
            data: { shipmentId: claim.id, provider: providerKey },
          },
        });
        throw new AppError(502, "PROVIDER_ERROR", message, { shipmentId: claim.id });
      }
      const blob: TrackingBlob = {
        events: [],
        meta: { providerShipmentId: result.providerShipmentId, provider: providerKey },
        ...(b.items ? { items: b.items } : {}),
      };
      const shipment = await p.shipment.update({
        where: { id: claim.id },
        data: {
          status: "CREATED",
          providerShipmentId: result.providerShipmentId,
          awb: b.awb ?? result.awb ?? null,
          carrier: b.carrier ?? result.carrier ?? null,
          trackingUrl: b.trackingUrl ?? result.trackingUrl ?? null,
          trackingEvents: blob as unknown as Prisma.InputJsonValue,
          error: null,
        },
      });
      let order;
      try {
        order = await transitionOrder(ctx, found.id, "SHIPPED", actor, "Shipment created");
      } catch (err) {
        // the order changed under us: do not leave an orphan shipment at the carrier
        await impl.cancelShipment(result.providerShipmentId).catch(() => undefined);
        await p.shipment.update({
          where: { id: shipment.id },
          data: {
            status: "CANCELLED",
            error: "Order changed while the shipment was being created",
          },
        });
        throw err;
      }
      await p.orderEvent.create({
        data: {
          orderId: found.id,
          type: "SHIPMENT_CREATED",
          message: shipment.awb ? `Shipment created (AWB ${shipment.awb})` : "Shipment created",
          actorType: "ADMIN",
          actorId: req.admin!.id,
          data: { shipmentId: shipment.id, provider: providerKey },
        },
      });
      await notify(ctx, "order.shipped", order.email, {
        name: customerNameOf(order),
        orderNumber: order.orderNumber,
        trackingUrl: shipment.trackingUrl ?? "",
        awb: shipment.awb ?? "",
        carrier: shipment.carrier ?? "",
      });
      await audit(ctx, req, {
        action: "shipment.create",
        entityType: "Shipment",
        entityId: shipment.id,
        extra: { orderId: found.id, provider: providerKey, awb: shipment.awb },
      });
      res.status(201).json(shipmentDto(shipment));
    }),
  );

  admin.post(
    "/shipments/:id/cancel",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const s = await p.shipment.findUnique({ where: { id } });
      if (!s) throw AppError.notFound("Shipment");
      if (s.status !== "CREATED" && s.status !== "IN_TRANSIT")
        throw AppError.conflict(`A ${s.status} shipment cannot be cancelled`);
      const impl = ctx.providers.shipping[s.provider];
      if (!impl) throw new AppError(502, "PROVIDER_ERROR", "Shipping provider is unavailable");
      const providerShipmentId =
        s.providerShipmentId ?? (blobOf(s).meta.providerShipmentId as string | undefined);
      try {
        if (providerShipmentId) await impl.cancelShipment(providerShipmentId);
      } catch (err) {
        ctx.logger.error({ err, shipmentId: id }, "shipment cancel failed");
        throw new AppError(
          502,
          "PROVIDER_ERROR",
          safeProviderMessage(err, "The shipping provider could not cancel the shipment"),
        );
      }
      const upd = await p.shipment.updateMany({
        where: { id, status: { in: ["CREATED", "IN_TRANSIT"] } },
        data: { status: "CANCELLED" },
      });
      if (upd.count === 1)
        await p.orderEvent.create({
          data: {
            orderId: s.orderId,
            type: "SHIPMENT_CANCELLED",
            message: s.awb ? `Shipment ${s.awb} cancelled` : "Shipment cancelled",
            actorType: "ADMIN",
            actorId: req.admin!.id,
            data: { shipmentId: id },
          },
        });
      await audit(ctx, req, { action: "shipment.cancel", entityType: "Shipment", entityId: id });
      res.json(shipmentDto(await p.shipment.findUniqueOrThrow({ where: { id } })));
    }),
  );

  async function markDelivered(orderId: string, actor: Actor) {
    const o = await p.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (o?.status === "SHIPPED") {
      try {
        await transitionOrder(ctx, orderId, "DELIVERED", actor, "Shipment delivered");
      } catch (err) {
        if (!(err instanceof AppError && err.status === 409)) throw err;
      }
    }
  }

  admin.post(
    "/shipments/:id/refresh-tracking",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const s = await p.shipment.findUnique({ where: { id } });
      if (!s) throw AppError.notFound("Shipment");
      if (s.status === "CANCELLED" || s.status === "FAILED" || s.status === "CREATING")
        throw AppError.conflict(`A ${s.status} shipment cannot be tracked`);
      const actor: Actor = { type: "ADMIN", id: req.admin!.id };
      if (s.provider === "MANUAL" || !s.providerShipmentId) return void res.json(shipmentDto(s)); // manual shipments are updated by hand
      const impl = ctx.providers.shipping[s.provider];
      if (!impl) throw new AppError(502, "PROVIDER_ERROR", "Shipping provider is unavailable");
      let tracking;
      try {
        tracking = await impl.trackShipment(s.providerShipmentId, s.awb ?? undefined);
      } catch (err) {
        ctx.logger.error({ err, shipmentId: id }, "tracking refresh failed");
        throw new AppError(
          502,
          "PROVIDER_ERROR",
          safeProviderMessage(err, "Tracking is unavailable right now"),
        );
      }
      const blob = blobOf(s);
      blob.events = tracking.events;
      // never move backwards (e.g. DELIVERED -> CREATED)
      const rank: Record<string, number> = {
        CREATED: 0,
        IN_TRANSIT: 1,
        DELIVERED: 2,
        CANCELLED: 2,
        FAILED: 2,
      };
      const next =
        (rank[tracking.status] ?? 0) >= (rank[s.status] ?? 0) ? tracking.status : s.status;
      const updated = await p.shipment.update({
        where: { id },
        data: { status: next, trackingEvents: blob as unknown as Prisma.InputJsonValue },
      });
      if (next === "DELIVERED") await markDelivered(s.orderId, actor);
      res.json(shipmentDto(updated));
    }),
  );

  admin.patch(
    "/shipments/:id",
    requirePermission("orders.update"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(patchBody, req.body ?? {});
      const s = await p.shipment.findUnique({ where: { id } });
      if (!s) throw AppError.notFound("Shipment");
      if (s.status === "CANCELLED" || s.status === "FAILED" || s.status === "CREATING")
        throw AppError.conflict(`A ${s.status} shipment cannot be edited`);
      if (b.status) {
        const order: Record<string, number> = { CREATED: 0, IN_TRANSIT: 1, DELIVERED: 2 };
        if ((order[b.status] ?? 0) <= (order[s.status] ?? 0))
          throw AppError.conflict(`Cannot move a ${s.status} shipment to ${b.status}`);
      }
      const updated = await p.shipment.update({
        where: { id },
        data: {
          ...(b.awb !== undefined ? { awb: b.awb } : {}),
          ...(b.carrier !== undefined ? { carrier: b.carrier } : {}),
          ...(b.trackingUrl !== undefined ? { trackingUrl: b.trackingUrl } : {}),
          ...(b.status ? { status: b.status } : {}),
        },
      });
      if (b.status === "DELIVERED")
        await markDelivered(s.orderId, { type: "ADMIN", id: req.admin!.id });
      await audit(ctx, req, {
        action: "shipment.update",
        entityType: "Shipment",
        entityId: id,
        before: { awb: s.awb, carrier: s.carrier, status: s.status },
        after: b,
      });
      res.json(shipmentDto(updated));
    }),
  );

  return { public: pub, admin };
}
