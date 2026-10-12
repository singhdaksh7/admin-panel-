import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import { addToCart, registerCustomer, seedProduct, stockOf } from "./commerceHelpers";
import { advanceTo, deliveredOrder, placeOrder, payViaVerify } from "./paymentsHelpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let ctx: Awaited<ReturnType<typeof bootApp>>["ctx"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
beforeAll(async () => {
  ({ app, ctx } = await bootApp());
  admin = await loginAdmin(app);
});

const EMAIL = "buyer@example.com";
const ADM = "/api/v1/admin";

async function delivered(qty = 4, price = "10.00") {
  const d = await deliveredOrder(app, ctx, { qty, price, email: EMAIL });
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: d.order.id } });
  return { ...d, item };
}
const req = (
  d: { order: { orderNumber: string }; item: { id: string } },
  quantity: number,
  over: object = {},
) =>
  request(app)
    .post("/api/v1/returns")
    .send({
      orderNumber: d.order.orderNumber,
      email: EMAIL,
      reason: "Damaged",
      details: "Box was crushed",
      items: [{ orderItemId: d.item.id, quantity }],
      ...over,
    });
const orderStatus = async (id: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

describe("return requests", () => {
  it("creates a return for a delivered order and moves the order to RETURN_REQUESTED", async () => {
    const d = await delivered();
    const r = await req(d, 2);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: "REQUESTED",
      reason: "Damaged",
      orderNumber: d.order.orderNumber,
    });
    expect(r.body.items[0].quantity).toBe(2);
    expect(r.body.history).toHaveLength(1);
    expect(await orderStatus(d.order.id)).toBe("RETURN_REQUESTED");
    const get = await request(app).get(`/api/v1/returns/${r.body.id}?email=${EMAIL}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(r.body.id);
  });

  it("is IDOR safe for creating and reading", async () => {
    const d = await delivered();
    const wrong = await req(d, 1, { email: "evil@example.com" });
    expect(wrong.status).toBe(404);
    expect((await req(d, 1, { email: undefined })).status).toBe(404);
    expect((await req(d, 1, { orderNumber: "ORD-9" })).status).toBe(404);
    const ok = await req(d, 1);
    expect(ok.status).toBe(201);
    expect(
      (await request(app).get(`/api/v1/returns/${ok.body.id}?email=evil@example.com`)).status,
    ).toBe(404);
    expect((await request(app).get(`/api/v1/returns/${ok.body.id}`)).status).toBe(404);
    expect((await request(app).get("/api/v1/returns/doesnotexist?email=" + EMAIL)).status).toBe(
      404,
    );
  });

  it("only accepts delivered orders within the return window", async () => {
    const pending = await placeOrder(app, { email: EMAIL });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: pending.order.id } });
    expect((await req({ order: pending.order, item }, 1)).status).toBe(409);
    await payViaVerify(app, pending);
    expect((await req({ order: pending.order, item }, 1)).status).toBe(409); // CONFIRMED

    const d = await delivered();
    await admin.put(`${ADM}/settings`, { checkout: { returnWindowDays: 7 } });
    await prisma.orderEvent.updateMany({
      where: { orderId: d.order.id, toStatus: "DELIVERED" },
      data: { createdAt: new Date(Date.now() - 8 * 86400_000) },
    });
    const late = await req(d, 1);
    expect(late.status).toBe(409);
    expect(late.body.error.message).toContain("7-day");
    await prisma.orderEvent.updateMany({
      where: { orderId: d.order.id, toStatus: "DELIVERED" },
      data: { createdAt: new Date(Date.now() - 6 * 86400_000) },
    });
    expect((await req(d, 1)).status).toBe(201);
    await admin.put(`${ADM}/settings`, { checkout: { returnWindowDays: 14 } });
  });

  it("validates items and caps quantities, including parallel requests", async () => {
    const d = await delivered(4);
    expect((await req(d, 5)).status).toBe(422);
    expect((await req(d, 0)).status).toBe(422);
    expect((await req(d, 1, { items: [{ orderItemId: "foreign", quantity: 1 }] })).status).toBe(
      422,
    );
    expect((await req(d, 1, { items: [] })).status).toBe(422);
    const rs = await Promise.all([req(d, 3), req(d, 3), req(d, 3), req(d, 2)]);
    const created = rs.filter((r) => r.status === 201);
    const qty = created.reduce((s, r) => s + (r.body.items[0].quantity as number), 0);
    expect(qty).toBeLessThanOrEqual(4);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(rs.filter((r) => r.status === 422).length + created.length).toBe(4);
    expect(await orderStatus(d.order.id)).toBe("RETURN_REQUESTED");
    const open = await prisma.returnItem.aggregate({
      where: { return: { orderId: d.order.id } },
      _sum: { quantity: true },
    });
    expect(open._sum.quantity).toBeLessThanOrEqual(4);
  });

  it("lets a signed-in customer request and list returns without an email", async () => {
    const cust = await registerCustomer(app, "member@example.com");
    const { variant } = await seedProduct({ price: "10.00", stock: 10 });
    const token = await addToCart(app, variant.id, 2);
    const co = await cust.agent
      .post("/api/v1/checkout/create")
      .set("x-csrf-token", cust.csrf)
      .send({
        cartToken: token,
        shippingAddress: { fullName: "M", line1: "x", city: "c", postalCode: "1", country: "IN" },
      });
    const order = await prisma.orderItem.findFirstOrThrow({
      where: { order: { orderNumber: co.body.order.orderNumber } },
      include: { order: true },
    });
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.orderId } });
    await cust.post("/api/v1/payments/verify", {
      orderNumber: order.order.orderNumber,
      providerOrderId: pay.providerOrderId,
      providerPaymentId: "pay_m",
      signature: (await import("../src/providers/payment/mock")).signMockPayment(
        pay.providerOrderId!,
        "pay_m",
      ),
    });
    await advanceTo(ctx, order.orderId, "DELIVERED");
    const r = await cust.post("/api/v1/returns", {
      orderNumber: order.order.orderNumber,
      reason: "Changed mind",
      items: [{ orderItemId: order.id, quantity: 1 }],
    });
    expect(r.status).toBe(201);
    const list = await cust.get("/api/v1/account/returns");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect((await request(app).get("/api/v1/account/returns")).status).toBe(401);
    const other = await registerCustomer(app, "other@example.com");
    expect((await other.get("/api/v1/account/returns")).body.items).toHaveLength(0);
    expect((await other.get(`/api/v1/returns/${r.body.id}`)).status).toBe(404);
    expect((await cust.get(`/api/v1/returns/${r.body.id}`)).status).toBe(200);
  });
});

describe("admin workflow", () => {
  it("runs the full flow: approve -> receive (per-item restock) -> refund -> order REFUNDED", async () => {
    const d = await delivered(4, "10.00");
    const stockBefore = (await stockOf(d.variantId)).onHand; // 20 - 4 committed = 16
    const r = (await req(d, 4)).body;
    expect((await admin.post(`${ADM}/returns/${r.id}/receive`, { items: [] })).status).toBe(409); // not approved
    expect((await admin.post(`${ADM}/returns/${r.id}/refund`, {})).status).toBe(409); // not received

    const ap = await admin.post(`${ADM}/returns/${r.id}/approve`, { note: "ok" });
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe("APPROVED");
    expect((await admin.post(`${ADM}/returns/${r.id}/approve`, {})).status).toBe(409);

    const detail = await admin.get(`${ADM}/returns/${r.id}`);
    const itemId = detail.body.items[0].id;
    const rc = await admin.post(`${ADM}/returns/${r.id}/receive`, {
      items: [{ returnItemId: itemId, restock: true }],
    });
    expect(rc.status).toBe(200);
    expect(rc.body.status).toBe("RECEIVED");
    expect(await orderStatus(d.order.id)).toBe("RETURNED");
    expect((await stockOf(d.variantId)).onHand).toBe(stockBefore + 4); // restocked exactly once
    const moves = await prisma.inventoryMovement.findMany({
      where: { orderId: d.order.id, type: { in: ["RETURN", "RESTOCK"] } },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.type).toBe("RETURN");
    expect((await admin.post(`${ADM}/returns/${r.id}/receive`, { items: [] })).status).toBe(409);

    const rf = await admin.post(`${ADM}/returns/${r.id}/refund`, {});
    expect(rf.status).toBe(201);
    expect(rf.body.refund).toMatchObject({ amount: "40.00", status: "PROCESSED" });
    expect(rf.body.return.status).toBe("REFUNDED");
    expect(rf.body.return.refundAmount).toBe("40.00");
    expect(await orderStatus(d.order.id)).toBe("REFUNDED");
    const oi = await prisma.orderItem.findUniqueOrThrow({ where: { id: d.item.id } });
    expect(oi.returnedQty).toBe(4);
    expect((await stockOf(d.variantId)).onHand).toBe(stockBefore + 4); // still once
    expect((await admin.post(`${ADM}/returns/${r.id}/refund`, {})).status).toBe(409);
    const hist = (await admin.get(`${ADM}/returns/${r.id}`)).body.history.map(
      (h: { status: string }) => h.status,
    );
    expect(hist).toEqual(["REQUESTED", "APPROVED", "RECEIVED", "REFUNDED"]);
    expect(
      await prisma.notificationLog.count({ where: { event: "return.update", recipient: EMAIL } }),
    ).toBeGreaterThanOrEqual(4);
    // nothing more can be returned
    expect((await req(d, 1)).status).toBe(409);
  });

  it("restock:false items are NOT restocked and the transition does not restock either", async () => {
    const d = await delivered(3);
    const before = (await stockOf(d.variantId)).onHand;
    const r = (await req(d, 3)).body;
    await admin.post(`${ADM}/returns/${r.id}/approve`, {});
    const itemId = (await admin.get(`${ADM}/returns/${r.id}`)).body.items[0].id;
    const rc = await admin.post(`${ADM}/returns/${r.id}/receive`, {
      items: [{ returnItemId: itemId, restock: false }],
    });
    expect(rc.status).toBe(200);
    expect(await orderStatus(d.order.id)).toBe("RETURNED");
    expect((await stockOf(d.variantId)).onHand).toBe(before);
    expect(
      await prisma.inventoryMovement.count({
        where: { orderId: d.order.id, type: { in: ["RETURN", "RESTOCK"] } },
      }),
    ).toBe(0);
    // omitted items default to no restock too
    expect(rc.body.items[0].restock).toBe(false);
  });

  it("partial return: partial refund, order stays RETURNED, cap applies", async () => {
    const d = await delivered(4, "10.00");
    const r = (await req(d, 1)).body;
    await admin.post(`${ADM}/returns/${r.id}/approve`, {});
    const itemId = (await admin.get(`${ADM}/returns/${r.id}`)).body.items[0].id;
    await admin.post(`${ADM}/returns/${r.id}/receive`, {
      items: [{ returnItemId: itemId, restock: true }],
    });
    expect((await admin.post(`${ADM}/returns/${r.id}/refund`, { amount: "99.00" })).status).toBe(
      422,
    );
    const rf = await admin.post(`${ADM}/returns/${r.id}/refund`, {});
    expect(rf.body.refund.amount).toBe("10.00");
    expect(await orderStatus(d.order.id)).toBe("RETURNED");
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: d.payment.id } });
    expect(pay.status).toBe("PARTIALLY_REFUNDED");
    expect(pay.refundedAmount.toFixed(2)).toBe("10.00");
    expect(
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: d.item.id } })).returnedQty,
    ).toBe(1);
  });

  it("reject sends the order back to DELIVERED; a rejected return frees the quantity", async () => {
    const d = await delivered(2);
    const r = (await req(d, 2)).body;
    expect((await req(d, 1)).status).toBe(422); // all quantity in an open return
    const rej = await admin.post(`${ADM}/returns/${r.id}/reject`, { note: "Out of policy" });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe("REJECTED");
    expect(rej.body.decisionNote).toBe("Out of policy");
    expect(await orderStatus(d.order.id)).toBe("DELIVERED");
    expect((await admin.post(`${ADM}/returns/${r.id}/reject`, {})).status).toBe(409);
    expect((await req(d, 2)).status).toBe(201);
  });

  it("two open returns: the order becomes RETURNED only after both are resolved", async () => {
    const d = await delivered(4);
    const a = (await req(d, 2)).body;
    const b = (await req(d, 2)).body;
    expect(await orderStatus(d.order.id)).toBe("RETURN_REQUESTED");
    await admin.post(`${ADM}/returns/${a.id}/approve`, {});
    await admin.post(`${ADM}/returns/${b.id}/approve`, {});
    const ia = (await admin.get(`${ADM}/returns/${a.id}`)).body.items[0].id;
    const ib = (await admin.get(`${ADM}/returns/${b.id}`)).body.items[0].id;
    await admin.post(`${ADM}/returns/${a.id}/receive`, {
      items: [{ returnItemId: ia, restock: true }],
    });
    expect(await orderStatus(d.order.id)).toBe("RETURN_REQUESTED");
    await admin.post(`${ADM}/returns/${b.id}/receive`, {
      items: [{ returnItemId: ib, restock: true }],
    });
    expect(await orderStatus(d.order.id)).toBe("RETURNED");
    await admin.post(`${ADM}/returns/${a.id}/refund`, {});
    expect(await orderStatus(d.order.id)).toBe("RETURNED");
    await admin.post(`${ADM}/returns/${b.id}/refund`, {});
    expect(await orderStatus(d.order.id)).toBe("REFUNDED");
    expect(
      await prisma.inventoryMovement.count({ where: { orderId: d.order.id, type: "RETURN" } }),
    ).toBe(2);
  });

  it("a manual-provider return refund stays pending until settled, then completes the return", async () => {
    const placed = await placeOrder(app, {
      provider: "MANUAL",
      qty: 2,
      price: "10.00",
      email: EMAIL,
    });
    await admin.post(`${ADM}/orders/${placed.order.id}/payments/mark-paid`, {});
    await advanceTo(ctx, placed.order.id, "DELIVERED");
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: placed.order.id } });
    const d = { order: placed.order, item };
    const r = (await req(d, 2)).body;
    await admin.post(`${ADM}/returns/${r.id}/approve`, {});
    const ri = (await admin.get(`${ADM}/returns/${r.id}`)).body.items[0].id;
    await admin.post(`${ADM}/returns/${r.id}/receive`, {
      items: [{ returnItemId: ri, restock: true }],
    });
    const rf = await admin.post(`${ADM}/returns/${r.id}/refund`, {});
    expect(rf.body.refund.status).toBe("PENDING");
    expect(rf.body.return.status).toBe("RECEIVED");
    expect((await admin.post(`${ADM}/returns/${r.id}/refund`, {})).status).toBe(409); // no second refund
    await admin.patch(`${ADM}/refunds/${rf.body.refund.id}`, { status: "PROCESSED" });
    expect((await admin.get(`${ADM}/returns/${r.id}`)).body.status).toBe("REFUNDED");
    expect(await orderStatus(placed.order.id)).toBe("REFUNDED");
  });

  it("lists with filters/pagination and enforces permissions", async () => {
    const list = await admin.get(`${ADM}/returns?status=REQUESTED&pageSize=2`);
    expect(list.status).toBe(200);
    expect(list.body.pageSize).toBe(2);
    expect(list.body.items.every((x: { status: string }) => x.status === "REQUESTED")).toBe(true);
    expect((await admin.get(`${ADM}/returns?q=ORD-`)).body.total).toBeGreaterThan(0);
    expect((await admin.get(`${ADM}/returns?status=BOGUS`)).status).toBe(422);
    expect((await admin.get(`${ADM}/returns/nope`)).status).toBe(404);

    await createAdminWithRole("ORDER_MANAGER", "om-ret@test.example");
    await createAdminWithRole("SUPPORT", "sup-ret@test.example");
    await createAdminWithRole("CATALOG_MANAGER", "cm-ret@test.example");
    const om = await loginAdmin(app, "om-ret@test.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup-ret@test.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm-ret@test.example", "Another-Pass-123");
    const d = await delivered(1);
    const r = (await req(d, 1)).body;
    expect((await sup.get(`${ADM}/returns/${r.id}`)).status).toBe(200);
    expect((await cm.get(`${ADM}/returns/${r.id}`)).status).toBe(403);
    expect((await sup.post(`${ADM}/returns/${r.id}/approve`, {})).status).toBe(403);
    expect((await cm.post(`${ADM}/returns/${r.id}/approve`, {})).status).toBe(403);
    expect((await om.post(`${ADM}/returns/${r.id}/approve`, {})).status).toBe(200);
    expect((await sup.post(`${ADM}/returns/${r.id}/receive`, { items: [] })).status).toBe(403);
    expect((await sup.post(`${ADM}/returns/${r.id}/refund`, {})).status).toBe(403);
    expect((await sup.post(`${ADM}/returns/${r.id}/reject`, {})).status).toBe(403);
  });
});
