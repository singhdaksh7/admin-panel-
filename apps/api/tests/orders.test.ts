import { beforeAll, describe, expect, it } from "vitest";
import type { OrderStatus } from "@kash-commerce/database";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import { addToCart, checkout, seedProduct, stockOf } from "./commerceHelpers";
import {
  TRANSITIONS,
  confirmOrder,
  expireUnpaidOrders,
  markPaymentStatus,
  transitionOrder,
} from "../src/modules/orders/service";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let ctx: Awaited<ReturnType<typeof bootApp>>["ctx"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
beforeAll(async () => {
  ({ app, ctx } = await bootApp());
  admin = await loginAdmin(app);
});

const SYS = { type: "SYSTEM" as const };

async function place(
  opts: { qty?: number; stock?: number; price?: string; provider?: string; email?: string } = {},
) {
  const { variant, product } = await seedProduct({
    stock: opts.stock ?? 10,
    price: opts.price ?? "10.00",
  });
  const token = await addToCart(app, variant.id, opts.qty ?? 2);
  const r = await checkout(app, token, {
    ...(opts.provider ? { paymentProvider: opts.provider } : {}),
    email: opts.email ?? "buyer@example.com",
  });
  if (r.status !== 201) throw new Error(`place failed ${r.status} ${JSON.stringify(r.body)}`);
  const order = await prisma.order.findUniqueOrThrow({
    where: { orderNumber: r.body.order.orderNumber },
  });
  return { order, variant, product };
}

const setStatus = (id: string, status: string, note?: string) =>
  admin.post(`/api/v1/admin/orders/${id}/status`, { status, note });

describe("transition table", () => {
  const ALL = Object.keys(TRANSITIONS) as OrderStatus[];

  it("matches the specification exactly", () => {
    expect(TRANSITIONS).toEqual({
      PENDING: ["CONFIRMED", "CANCELLED"],
      CONFIRMED: ["PROCESSING", "CANCELLED"],
      PROCESSING: ["PACKED", "CANCELLED"],
      PACKED: ["SHIPPED", "CANCELLED"],
      SHIPPED: ["DELIVERED", "RETURN_REQUESTED"],
      DELIVERED: ["RETURN_REQUESTED"],
      RETURN_REQUESTED: ["RETURNED", "DELIVERED"],
      RETURNED: ["REFUNDED"],
      CANCELLED: [],
      REFUNDED: [],
    });
  });

  it("allows every valid pair and rejects every invalid pair (100 combinations)", async () => {
    let n = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        const o = await prisma.order.create({
          data: {
            orderNumber: `TT-${n++}`,
            status: from,
            customerSnapshot: { email: "t@example.com", name: "T" },
            email: "t@example.com",
            currency: "USD",
            subtotal: "1.00",
            total: "1.00",
            shippingAddress: {},
            billingAddress: {},
          },
        });
        const valid = TRANSITIONS[from].includes(to);
        const res = await setStatus(o.id, to);
        expect(res.status, `${from} -> ${to}`).toBe(valid ? 200 : 409);
        const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
        expect(after.status, `${from} -> ${to}`).toBe(valid ? to : from);
      }
    }
  }, 120_000);
});

describe("lifecycle and stock", () => {
  it("runs PENDING -> ... -> REFUNDED with correct inventory and event timeline", async () => {
    const { order, variant } = await place({ qty: 3, stock: 10 });
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10, reserved: 3 });

    expect((await setStatus(order.id, "CONFIRMED")).status).toBe(200);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 7, reserved: 0 });
    for (const s of ["PROCESSING", "PACKED", "SHIPPED", "DELIVERED", "RETURN_REQUESTED"])
      expect((await setStatus(order.id, s)).status, s).toBe(200);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 7, reserved: 0 });
    expect((await setStatus(order.id, "RETURNED")).status).toBe(200);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10, reserved: 0 }); // restocked once
    expect((await setStatus(order.id, "REFUNDED")).status).toBe(200);
    expect((await setStatus(order.id, "PENDING")).status).toBe(409);

    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.toStatus)).toEqual([
      "PENDING",
      "CONFIRMED",
      "PROCESSING",
      "PACKED",
      "SHIPPED",
      "DELIVERED",
      "RETURN_REQUESTED",
      "RETURNED",
      "REFUNDED",
    ]);
    expect(events[0]!.type).toBe("ORDER_PLACED");
    expect(events.at(-1)).toMatchObject({ actorType: "ADMIN", fromStatus: "RETURNED" });
    const mails = await prisma.notificationLog.count({
      where: {
        event: { in: ["order.status", "order.processing", "order.shipped", "order.delivered", "order.cancelled"] },
        recipient: "buyer@example.com",
      },
    });
    expect(mails).toBeGreaterThanOrEqual(8);
  });

  it("cancel before confirmation RELEASES the reservation", async () => {
    const { order, variant } = await place({ qty: 4, stock: 10 });
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10, reserved: 4 });
    const res = await admin.post(`/api/v1/admin/orders/${order.id}/cancel`, {
      reason: "Customer asked",
    });
    expect(res.status).toBe(200);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10, reserved: 0 });
    const types = (
      await prisma.inventoryMovement.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((m) => m.type);
    expect(types).toEqual(["RESERVE", "RELEASE"]);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).cancelledAt,
    ).not.toBeNull();
    expect((await admin.post(`/api/v1/admin/orders/${order.id}/cancel`, {})).status).toBe(409);
  });

  it("cancel after confirmation RESTOCKS the sold units", async () => {
    const { order, variant } = await place({ qty: 4, stock: 10, provider: "MANUAL" });
    expect(order.status).toBe("CONFIRMED");
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 6, reserved: 0 });
    await setStatus(order.id, "PROCESSING");
    expect((await admin.post(`/api/v1/admin/orders/${order.id}/cancel`, {})).status).toBe(200);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10, reserved: 0 });
    const types = (
      await prisma.inventoryMovement.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((m) => m.type);
    expect(types).toEqual(["RESERVE", "COMMIT", "RESTOCK"]);
    // shipped orders cannot be cancelled
    const shipped = await place({ qty: 1, provider: "MANUAL" });
    for (const s of ["PROCESSING", "PACKED", "SHIPPED"]) await setStatus(shipped.order.id, s);
    expect((await admin.post(`/api/v1/admin/orders/${shipped.order.id}/cancel`, {})).status).toBe(
      409,
    );
  });

  it("confirmOrder is idempotent and refuses cancelled orders", async () => {
    const { order, variant } = await place({ qty: 2, stock: 5 });
    await confirmOrder(ctx, order.id, SYS);
    await confirmOrder(ctx, order.id, SYS);
    await Promise.all([confirmOrder(ctx, order.id, SYS), confirmOrder(ctx, order.id, SYS)]);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 3, reserved: 0 }); // committed exactly once
    expect(
      await prisma.inventoryMovement.count({ where: { orderId: order.id, type: "COMMIT" } }),
    ).toBe(1);
    const other = await place({ qty: 1 });
    await transitionOrder(ctx, other.order.id, "CANCELLED", SYS);
    await expect(confirmOrder(ctx, other.order.id, SYS)).rejects.toMatchObject({ status: 409 });
  });
});

describe("concurrency", () => {
  it("racing confirm vs cancel leaves exactly one outcome and consistent inventory", async () => {
    for (let round = 0; round < 3; round++) {
      const { order, variant } = await place({ qty: 2, stock: 10 });
      const calls = [
        ...Array.from({ length: 4 }, () => setStatus(order.id, "CONFIRMED")),
        ...Array.from({ length: 4 }, () =>
          admin.post(`/api/v1/admin/orders/${order.id}/cancel`, {}),
        ),
      ];
      const rs = await Promise.all(calls);
      const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const inv = await stockOf(variant.id);
      expect(inv.reserved).toBe(0);
      if (final.status === "CANCELLED") {
        expect(inv.onHand).toBe(10);
        // CONFIRMED then CANCELLED is also legal: net effect restock
      } else {
        expect(final.status).toBe("CONFIRMED");
        expect(inv.onHand).toBe(8);
      }
      // a row can be confirmed at most once and cancelled at most once
      expect(rs.filter((r) => r.status === 200).length).toBeLessThanOrEqual(2);
      expect(
        await prisma.inventoryMovement.count({ where: { orderId: order.id, type: "COMMIT" } }),
      ).toBeLessThanOrEqual(1);
    }
  });

  it("concurrent identical transitions apply once", async () => {
    const { order } = await place({ qty: 1, provider: "MANUAL" });
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => setStatus(order.id, "PROCESSING")),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(
      await prisma.orderEvent.count({ where: { orderId: order.id, toStatus: "PROCESSING" } }),
    ).toBe(1);
  });
});

describe("payments", () => {
  it("PAID confirms a pending order; replays are no-ops; PAID cannot be downgraded", async () => {
    const { order, variant } = await place({ qty: 1, stock: 4 });
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const paid = await markPaymentStatus(
      ctx,
      { orderId: order.id, paymentId: payment.id, status: "PAID", providerPaymentId: "pay_1" },
      { type: "WEBHOOK" },
    );
    expect(paid).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    await markPaymentStatus(
      ctx,
      { orderId: order.id, paymentId: payment.id, status: "PAID", providerPaymentId: "pay_1" },
      { type: "WEBHOOK" },
    );
    await markPaymentStatus(ctx, { orderId: order.id, status: "FAILED" }, { type: "WEBHOOK" });
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe("PAID");
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 3, reserved: 0 });
    expect(
      await prisma.orderEvent.count({ where: { orderId: order.id, type: "PAYMENT_PAID" } }),
    ).toBe(1);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).providerPaymentId,
    ).toBe("pay_1");
    await markPaymentStatus(ctx, { orderId: order.id, status: "PARTIALLY_REFUNDED" }, SYS);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      "PARTIALLY_REFUNDED",
    );
  });

  it("FAILED keeps the order pending; payment on a cancelled order is flagged", async () => {
    const a = await place({ qty: 1 });
    await markPaymentStatus(ctx, { orderId: a.order.id, status: "FAILED" }, SYS);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: a.order.id } })).toMatchObject({
      status: "PENDING",
      paymentStatus: "FAILED",
    });

    await transitionOrder(ctx, a.order.id, "CANCELLED", SYS);
    await markPaymentStatus(ctx, { orderId: a.order.id, status: "PAID" }, SYS);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: a.order.id } });
    expect(o).toMatchObject({ status: "CANCELLED", paymentStatus: "PAID" });
    expect(
      await prisma.orderEvent.count({
        where: { orderId: a.order.id, type: "PAYMENT_ON_CANCELLED_ORDER" },
      }),
    ).toBe(1);
    await expect(
      markPaymentStatus(ctx, { orderId: "nope", status: "PAID" }, SYS),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("expiry job", () => {
  it("cancels stale unpaid PENDING orders and releases stock; spares fresh, paid and COD orders", async () => {
    const stale = await place({ qty: 2, stock: 10 });
    const fresh = await place({ qty: 1, stock: 10 });
    const paid = await place({ qty: 1, stock: 10 });
    const cod = await place({ qty: 1, stock: 10, provider: "MANUAL" });
    const old = new Date(Date.now() - 61 * 60_000);
    await prisma.order.updateMany({
      where: { id: { in: [stale.order.id, paid.order.id, cod.order.id] } },
      data: { createdAt: old },
    });
    await prisma.order.update({ where: { id: paid.order.id }, data: { paymentStatus: "PAID" } });

    const n = await expireUnpaidOrders(ctx);
    expect(n).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: stale.order.id } })).status).toBe(
      "CANCELLED",
    );
    expect(await stockOf(stale.variant.id)).toMatchObject({ onHand: 10, reserved: 0 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: fresh.order.id } })).status).toBe(
      "PENDING",
    );
    expect((await prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } })).status).toBe(
      "PENDING",
    );
    expect((await prisma.order.findUniqueOrThrow({ where: { id: cod.order.id } })).status).toBe(
      "CONFIRMED",
    );
    expect(await expireUnpaidOrders(ctx)).toBe(0);
  });
});

describe("admin orders API", () => {
  it("lists with filters, search, sorting and pagination", async () => {
    const a = await place({
      qty: 1,
      price: "10.00",
      email: "alice-list@example.com",
      provider: "MANUAL",
    });
    const b = await place({ qty: 5, price: "10.00", email: "bob-list@example.com" });
    const list = await admin.get("/api/v1/admin/orders?pageSize=500");
    expect(list.body.total).toBeGreaterThan(5);
    expect(list.body.items[0]).toHaveProperty("orderNumber");

    const byEmail = await admin.get("/api/v1/admin/orders?q=alice-list");
    expect(byEmail.body.items.map((o: { id: string }) => o.id)).toEqual([a.order.id]);
    const byNumber = await admin.get(`/api/v1/admin/orders?q=${b.order.orderNumber}`);
    expect(byNumber.body.items.map((o: { id: string }) => o.id)).toEqual([b.order.id]);
    const byName = await admin.get("/api/v1/admin/orders?q=asha%20rao&pageSize=2");
    expect(byName.body.pageSize).toBe(2);
    expect(byName.body.items).toHaveLength(2);
    expect(byName.body.totalPages).toBeGreaterThan(1);

    const confirmed = await admin.get("/api/v1/admin/orders?status=CONFIRMED&q=list");
    expect(confirmed.body.items.map((o: { id: string }) => o.id)).toEqual([a.order.id]);
    const unpaid = await admin.get("/api/v1/admin/orders?paymentStatus=PENDING&q=bob-list");
    expect(unpaid.body.total).toBe(1);
    const future = await admin.get(
      `/api/v1/admin/orders?from=${new Date(Date.now() + 86400_000).toISOString()}`,
    );
    expect(future.body.total).toBe(0);
    const sorted = await admin.get("/api/v1/admin/orders?q=-list&sort=total&dir=desc");
    expect(sorted.body.items.map((o: { id: string }) => o.id)).toEqual([b.order.id, a.order.id]);
    expect((await admin.get("/api/v1/admin/orders?status=BOGUS")).status).toBe(422);
  });

  it("returns a full detail view and supports notes", async () => {
    const { order } = await place({ qty: 2, provider: "MANUAL" });
    const note = await admin.post(`/api/v1/admin/orders/${order.id}/notes`, {
      body: "Gift wrap please",
    });
    expect(note.status).toBe(201);
    expect((await admin.post(`/api/v1/admin/orders/${order.id}/notes`, { body: "" })).status).toBe(
      422,
    );
    const d = await admin.get(`/api/v1/admin/orders/${order.id}`);
    expect(d.status).toBe(200);
    expect(d.body.items).toHaveLength(1);
    expect(d.body.items[0].unitPrice).toBe("10.00");
    expect(d.body.notes[0].body).toBe("Gift wrap please");
    expect(d.body.events.length).toBeGreaterThanOrEqual(3);
    expect(d.body.payments[0].provider).toBe("MANUAL");
    expect(d.body.shipments).toEqual([]);
    expect(d.body.invoice).toEqual({ status: "NOT_GENERATED" });
    expect((await admin.get(`/api/v1/admin/orders/${order.orderNumber}`)).body.id).toBe(order.id);
    expect((await admin.get("/api/v1/admin/orders/doesnotexist")).status).toBe(404);
  });

  it("enforces permissions: ORDER_MANAGER may update, CATALOG_MANAGER may not even read", async () => {
    await createAdminWithRole("ORDER_MANAGER", "om-o@test.example");
    await createAdminWithRole("CATALOG_MANAGER", "cm-o@test.example");
    await createAdminWithRole("SUPPORT", "sup-o@test.example");
    const om = await loginAdmin(app, "om-o@test.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm-o@test.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup-o@test.example", "Another-Pass-123");
    const { order } = await place({ qty: 1 });
    expect((await om.get("/api/v1/admin/orders")).status).toBe(200);
    expect((await cm.get("/api/v1/admin/orders")).status).toBe(403);
    expect((await cm.get(`/api/v1/admin/orders/${order.id}`)).status).toBe(403);
    expect(
      (await cm.post(`/api/v1/admin/orders/${order.id}/status`, { status: "CONFIRMED" })).status,
    ).toBe(403);
    expect((await sup.get("/api/v1/admin/orders")).status).toBe(200);
    expect((await sup.post(`/api/v1/admin/orders/${order.id}/cancel`, {})).status).toBe(403);
    expect((await sup.post(`/api/v1/admin/orders/${order.id}/notes`, { body: "x" })).status).toBe(
      403,
    );
    expect((await request(app).get("/api/v1/admin/orders")).status).toBe(401);
    // CSRF is enforced for unsafe methods
    expect(
      (await om.agent.post(`/api/v1/admin/orders/${order.id}/status`).send({ status: "CONFIRMED" }))
        .status,
    ).toBe(403);
    expect(
      (
        await om.post(`/api/v1/admin/orders/${order.id}/status`, {
          status: "CONFIRMED",
          note: "ok",
        })
      ).status,
    ).toBe(200);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "order.status", entityId: order.id },
    });
    expect(audit?.actorEmail).toBe("om-o@test.example");
  });
});

describe("dashboard summary", () => {
  it("aggregates revenue, statuses, low stock, top products and alerts", async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "Order", "OrderItem" RESTART IDENTITY CASCADE`);
    const hot = await seedProduct({ title: "Hot Item", price: "20.00", stock: 6 });
    await prisma.inventoryItem.deleteMany({ where: { variantId: { not: hot.variant.id } } });
    const t1 = await addToCart(app, hot.variant.id, 3);
    const o1 = await checkout(app, t1, { paymentProvider: "MANUAL" });
    const t2 = await addToCart(app, hot.variant.id, 1);
    const o2 = await checkout(app, t2);
    const paidOrder = await prisma.order.findUniqueOrThrow({
      where: { orderNumber: o1.body.order.orderNumber },
    });
    await markPaymentStatus(ctx, { orderId: paidOrder.id, status: "PAID" }, SYS);
    const pend = await prisma.order.findUniqueOrThrow({
      where: { orderNumber: o2.body.order.orderNumber },
    });
    await prisma.order.update({
      where: { id: pend.id },
      data: { createdAt: new Date(Date.now() - 45 * 60_000) },
    });

    const res = await admin.get("/api/v1/admin/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body.revenue.today).toEqual({ revenue: "60.00", orders: 1 });
    expect(res.body.revenue.last7Days.revenue).toBe("60.00");
    expect(res.body.revenue.last30Days.orders).toBe(1);
    expect(res.body.ordersByStatus).toMatchObject({ CONFIRMED: 1, PENDING: 1, CANCELLED: 0 });
    // stock: onHand 6-3 = 3, reserved 1 => available 2 <= threshold 5
    expect(res.body.lowStock[0]).toMatchObject({ sku: hot.variant.sku, available: 2 });
    expect(res.body.topProducts[0]).toMatchObject({
      title: "Hot Item",
      quantity: 3,
      revenue: "60.00",
    });
    expect(res.body.recentOrders).toHaveLength(2);
    expect(res.body.alerts).toMatchObject({ pendingUnpaidOrders: 1, lowStockVariants: 1 });

    await createAdminWithRole("CATALOG_MANAGER", "cm-d@test.example");
    const cm = await loginAdmin(app, "cm-d@test.example", "Another-Pass-123");
    expect((await cm.get("/api/v1/admin/dashboard/summary")).status).toBe(200);
    expect((await request(app).get("/api/v1/admin/dashboard/summary")).status).toBe(401);
  });
});
