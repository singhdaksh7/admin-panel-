import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import { advanceTo, payViaVerify, placeOrder } from "./paymentsHelpers";
import { MockShippingProvider } from "../src/providers/shipping/mock";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let ctx: Awaited<ReturnType<typeof bootApp>>["ctx"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
const mock = () => ctx.providers.shipping.MOCK as MockShippingProvider;
beforeAll(async () => {
  ({ app, ctx } = await bootApp());
  ctx.providers.activeShipping = "MOCK";
  admin = await loginAdmin(app);
});

async function packed() {
  const placed = await placeOrder(app, { email: "ship@example.com" });
  await payViaVerify(app, placed);
  await advanceTo(ctx, placed.order.id, "PACKED");
  return placed;
}
const statusOf = async (id: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

describe("create shipment", () => {
  it("creates a shipment via the active provider, ships the order and notifies", async () => {
    const placed = await packed();
    const r = await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ provider: "MOCK", status: "CREATED", carrier: "MockCarrier" });
    expect(r.body.awb).toMatch(/^MOCKAWB/);
    expect(r.body.providerShipmentId).toMatch(/^mock_ship_/);
    expect(await statusOf(placed.order.id)).toBe("SHIPPED");
    const row = await prisma.shipment.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(
      (row.trackingEvents as { meta: { providerShipmentId: string } }).meta.providerShipmentId,
    ).toBe(row.providerShipmentId);
    expect(
      await prisma.notificationLog.count({
        where: { event: "order.shipped", recipient: "ship@example.com" },
      }),
    ).toBeGreaterThan(0);
    const list = await admin.get(`/api/v1/admin/orders/${placed.order.id}/shipments`);
    expect(list.body.items).toHaveLength(1);
    const detail = await admin.get(`/api/v1/admin/orders/${placed.order.id}`);
    expect(detail.body.shipments).toHaveLength(1);
  });

  it("rejects orders that are not PACKED with a clear 409 and does not call the provider", async () => {
    const placed = await placeOrder(app);
    await payViaVerify(app, placed);
    const r = await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("PACKED");
    expect(await prisma.shipment.count({ where: { orderId: placed.order.id } })).toBe(0);
    expect(await statusOf(placed.order.id)).toBe("CONFIRMED");
  });

  it("provider failure: FAILED shipment row, safe 502, order untouched, retry works", async () => {
    const placed = await packed();
    mock().failNext("create");
    const r = await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {});
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("PROVIDER_ERROR");
    expect(await statusOf(placed.order.id)).toBe("PACKED");
    const failed = await prisma.shipment.findMany({ where: { orderId: placed.order.id } });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe("FAILED");
    expect(failed[0]!.error).toBeTruthy();
    const retry = await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {});
    expect(retry.status).toBe(201);
    expect(await statusOf(placed.order.id)).toBe("SHIPPED");
  });

  it("supports a MANUAL shipment with an admin-entered AWB", async () => {
    const placed = await packed();
    const r = await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {
      provider: "manual",
      carrier: "Local Courier",
      awb: "LC12345",
      trackingUrl: "https://courier.example.test/LC12345",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ provider: "MANUAL", awb: "LC12345", carrier: "Local Courier" });
    const bad = await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {
      provider: "nope",
    });
    expect(bad.status).toBe(422);
  });

  it("only one of several parallel creations succeeds", async () => {
    const placed = await packed();
    const rs = await Promise.all(
      [1, 2, 3].map(() => admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {})),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(
      await prisma.shipment.count({ where: { orderId: placed.order.id, status: "CREATED" } }),
    ).toBe(1);
  });

  it("validates item selections", async () => {
    const placed = await packed();
    const r = await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {
      items: [{ orderItemId: "nope", quantity: 1 }],
    });
    expect(r.status).toBe(422);
  });
});

describe("cancel / tracking", () => {
  it("cancels a shipment through the provider, and a provider cancel failure leaves it intact", async () => {
    const placed = await packed();
    const s = (await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {})).body;
    mock().failNext("cancel");
    const fail = await admin.post(`/api/v1/admin/shipments/${s.id}/cancel`, {});
    expect(fail.status).toBe(502);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      "CREATED",
    );
    const ok = await admin.post(`/api/v1/admin/shipments/${s.id}/cancel`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("CANCELLED");
    expect((await admin.post(`/api/v1/admin/shipments/${s.id}/cancel`, {})).status).toBe(409);
    // after cancelling a new shipment may be created? order stays SHIPPED -> not PACKED -> 409
    expect((await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {})).status).toBe(
      409,
    );
  });

  it("refresh-tracking progresses to DELIVERED and delivers the order", async () => {
    const placed = await packed();
    const s = (await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {})).body;
    const t1 = await admin.post(`/api/v1/admin/shipments/${s.id}/refresh-tracking`, {});
    expect(t1.body.status).toBe("CREATED");
    const t2 = await admin.post(`/api/v1/admin/shipments/${s.id}/refresh-tracking`, {});
    expect(t2.body.status).toBe("IN_TRANSIT");
    expect(await statusOf(placed.order.id)).toBe("SHIPPED");
    const t3 = await admin.post(`/api/v1/admin/shipments/${s.id}/refresh-tracking`, {});
    expect(t3.body.status).toBe("DELIVERED");
    expect(t3.body.events.length).toBeGreaterThan(0);
    expect(await statusOf(placed.order.id)).toBe("DELIVERED");
    mock().failNext("track");
    expect((await admin.post(`/api/v1/admin/shipments/${s.id}/refresh-tracking`, {})).status).toBe(
      502,
    );
  });

  it("PATCH updates manual details and statuses forward only", async () => {
    const placed = await packed();
    const s = (
      await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {
        provider: "MANUAL",
        awb: "A1",
      })
    ).body;
    const p1 = await admin.patch(`/api/v1/admin/shipments/${s.id}`, {
      awb: "A2",
      status: "IN_TRANSIT",
    });
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ awb: "A2", status: "IN_TRANSIT" });
    expect(
      (await admin.patch(`/api/v1/admin/shipments/${s.id}`, { status: "IN_TRANSIT" })).status,
    ).toBe(409);
    const p2 = await admin.patch(`/api/v1/admin/shipments/${s.id}`, { status: "DELIVERED" });
    expect(p2.body.status).toBe("DELIVERED");
    expect(await statusOf(placed.order.id)).toBe("DELIVERED");
  });

  it("public tracking is IDOR safe", async () => {
    const placed = await packed();
    await admin.post(`/api/v1/admin/orders/${placed.order.id}/shipments`, {});
    const n = placed.order.orderNumber;
    const ok = await request(app).get(`/api/v1/orders/${n}/tracking?email=ship@example.com`);
    expect(ok.status).toBe(200);
    expect(ok.body.shipments).toHaveLength(1);
    expect(ok.body.shipments[0].awb).toMatch(/^MOCKAWB/);
    expect(ok.body.shipments[0]).not.toHaveProperty("providerShipmentId");
    const wrong = await request(app).get(`/api/v1/orders/${n}/tracking?email=evil@example.com`);
    const missing = await request(app).get("/api/v1/orders/ORD-1/tracking?email=evil@example.com");
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(wrong.body.error.message).toBe(missing.body.error.message);
    expect((await request(app).get(`/api/v1/orders/${n}/tracking`)).status).toBe(404);
  });
});

describe("rates + permissions", () => {
  it("returns rates best-effort", async () => {
    const placed = await packed();
    const ok = await admin.get(`/api/v1/admin/shipping/rates?orderId=${placed.order.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.rates.length).toBeGreaterThan(0);
    mock().failNext("rates");
    const fail = await admin.get(`/api/v1/admin/shipping/rates?orderId=${placed.order.id}`);
    expect(fail.status).toBe(200);
    expect(fail.body.rates).toEqual([]);
    expect(fail.body.error).toBeTruthy();
    expect((await admin.get("/api/v1/admin/shipping/rates")).status).toBe(422);
  });

  it("enforces permissions", async () => {
    await createAdminWithRole("ORDER_MANAGER", "om-sh@test.example");
    await createAdminWithRole("SUPPORT", "sup-sh@test.example");
    await createAdminWithRole("CATALOG_MANAGER", "cm-sh@test.example");
    const om = await loginAdmin(app, "om-sh@test.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup-sh@test.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm-sh@test.example", "Another-Pass-123");
    const placed = await packed();
    const url = `/api/v1/admin/orders/${placed.order.id}/shipments`;
    expect((await sup.post(url, {})).status).toBe(403);
    expect((await cm.post(url, {})).status).toBe(403);
    expect((await sup.get(url)).status).toBe(200);
    expect((await cm.get(url)).status).toBe(403);
    const created = await om.post(url, {});
    expect(created.status).toBe(201);
    expect((await sup.post(`/api/v1/admin/shipments/${created.body.id}/cancel`, {})).status).toBe(
      403,
    );
    expect(
      (await sup.post(`/api/v1/admin/shipments/${created.body.id}/refresh-tracking`, {})).status,
    ).toBe(403);
    expect(
      (await sup.patch(`/api/v1/admin/shipments/${created.body.id}`, { awb: "x" })).status,
    ).toBe(403);
  });
});
