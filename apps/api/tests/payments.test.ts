import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import { addToCart, registerCustomer, seedProduct } from "./commerceHelpers";
import { SYS, payViaVerify, placeOrder, verifyBody } from "./paymentsHelpers";
import { MockPaymentProvider } from "../src/providers/payment/mock";
import { markPaymentStatus } from "../src/modules/orders/service";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let ctx: Awaited<ReturnType<typeof bootApp>>["ctx"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
beforeAll(async () => {
  ({ app, ctx } = await bootApp());
  admin = await loginAdmin(app);
});

const verify = (body: object) => request(app).post("/api/v1/payments/verify").send(body);
const mock = () => ctx.providers.payment.MOCK as MockPaymentProvider;

describe("POST /payments/verify", () => {
  it("verifies a valid signature, confirms the order and is double-submit safe", async () => {
    const placed = await placeOrder(app);
    const body = verifyBody(placed);
    const [a, b] = await Promise.all([verify(body), verify(body)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toMatchObject({ paid: true, paymentStatus: "PAID", orderStatus: "CONFIRMED" });
    const again = await verify(body);
    expect(again.status).toBe(200);
    const events = await prisma.orderEvent.count({
      where: { orderId: placed.order.id, type: "PAYMENT_PAID" },
    });
    expect(events).toBe(1);
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.providerPaymentId).toBe("pay_test_1");
  });

  it("rejects a bad signature, marks the PENDING payment FAILED and never confirms", async () => {
    const placed = await placeOrder(app);
    const r = await verify(verifyBody(placed, "pay_x", { signature: "deadbeef" }));
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("PAYMENT_FAILED");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(o.status).toBe("PENDING");
    expect(o.paymentStatus).toBe("FAILED");
    // a later correct signature still succeeds (FAILED -> PAID)
    expect((await verify(verifyBody(placed, "pay_ok"))).status).toBe(200);
  });

  it("a forged signature can never downgrade a PAID payment", async () => {
    const placed = await placeOrder(app);
    await payViaVerify(app, placed);
    const r = await verify(verifyBody(placed, "pay_evil", { signature: "00" }));
    expect(r.status).toBe(402);
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.status).toBe("PAID");
  });

  it("ignores a client-claimed status and refuses when the stored amount was tampered with", async () => {
    const placed = await placeOrder(app);
    const claimed = await verify(
      verifyBody(placed, "pay_c", { status: "PAID", signature: "nope" }),
    );
    expect(claimed.status).toBe(402);
    await prisma.payment.update({ where: { id: placed.payment.id }, data: { amount: "1.00" } });
    const r = await verify(verifyBody(placed, "pay_t"));
    expect(r.status).toBe(409);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(o.paymentStatus).not.toBe("PAID");
  });

  it("is IDOR safe: wrong order, wrong email and unknown order all look the same", async () => {
    const a = await placeOrder(app, { email: "alice@example.com" });
    const b = await placeOrder(app, { email: "bob@example.com" });
    // alice's payment reference with bob's order number
    const wrongOrder = await verify(verifyBody(a, "p1", { orderNumber: b.order.orderNumber }));
    expect(wrongOrder.status).toBe(404);
    const wrongEmail = await verify(verifyBody(a, "p1", { email: "bob@example.com" }));
    expect(wrongEmail.status).toBe(404);
    const noEmail = await verify(verifyBody(a, "p1", { email: undefined }));
    expect(noEmail.status).toBe(404);
    const unknown = await verify(verifyBody(a, "p1", { orderNumber: "ORD-0" }));
    expect(unknown.status).toBe(404);
    expect(wrongEmail.body.error.message).toBe(unknown.body.error.message);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: a.order.id } });
    expect(o.paymentStatus).toBe("PENDING");
  });

  it("lets the owning customer verify without supplying an email", async () => {
    const cust = await registerCustomer(app, "owner@example.com");
    const { variant } = await seedProduct({ price: "5.00", stock: 5 });
    const token = await addToCart(app, variant.id, 1);
    const r = await cust.agent
      .post("/api/v1/checkout/create")
      .set("x-csrf-token", cust.csrf)
      .send({
        cartToken: token,
        shippingAddress: { fullName: "O", line1: "x", city: "c", postalCode: "1", country: "IN" },
      });
    expect(r.status).toBe(201);
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderNumber: r.body.order.orderNumber },
    });
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const v = await cust.post("/api/v1/payments/verify", {
      orderNumber: order.orderNumber,
      providerOrderId: pay.providerOrderId,
      providerPaymentId: "pay_o",
      signature: mock().signMockPayment(pay.providerOrderId!, "pay_o"),
    });
    expect(v.status).toBe(200);
    expect(v.body.paid).toBe(true);
  });
});

describe("POST /payments/retry", () => {
  it("re-initiates payment for a FAILED payment and rejects paid / in-progress orders", async () => {
    const placed = await placeOrder(app);
    const inProgress = await request(app)
      .post("/api/v1/payments/retry")
      .send({ orderNumber: placed.order.orderNumber, email: placed.email });
    expect(inProgress.status).toBe(409);
    await verify(verifyBody(placed, "pay_f", { signature: "bad" }));
    const retry = await request(app)
      .post("/api/v1/payments/retry")
      .send({ orderNumber: placed.order.orderNumber, email: placed.email });
    expect(retry.status).toBe(200);
    expect(retry.body.clientPayload.providerOrderId).toBe(placed.payment.providerOrderId);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(o.paymentStatus).toBe("PENDING");
    expect((await verify(verifyBody(placed, "pay_retry"))).status).toBe(200);
    const paid = await request(app)
      .post("/api/v1/payments/retry")
      .send({ orderNumber: placed.order.orderNumber, email: placed.email });
    expect(paid.status).toBe(409);
  });

  it("recovers an order whose payment initiation never produced a provider order", async () => {
    const placed = await placeOrder(app);
    await prisma.payment.update({
      where: { id: placed.payment.id },
      data: { providerOrderId: null },
    });
    const retry = await request(app)
      .post("/api/v1/payments/retry")
      .send({ orderNumber: placed.order.orderNumber, email: placed.email });
    expect(retry.status).toBe(200);
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.providerOrderId).toBeTruthy();
  });

  it("is IDOR safe", async () => {
    const placed = await placeOrder(app);
    const r = await request(app)
      .post("/api/v1/payments/retry")
      .send({ orderNumber: placed.order.orderNumber, email: "nobody@example.com" });
    expect(r.status).toBe(404);
  });
});

describe("webhooks", () => {
  const send = (payload: object, sig?: string) => {
    const raw = JSON.stringify(payload);
    return request(app)
      .post("/api/v1/webhooks/mock")
      .set("content-type", "application/json")
      .set("x-mock-signature", sig ?? mock().signWebhookBody(raw))
      .send(raw);
  };

  it("applies a valid PAID event once and ignores replays (5 parallel deliveries)", async () => {
    const placed = await placeOrder(app, { price: "12.50", qty: 2 });
    const payload = {
      id: "evt_parallel_1",
      type: "payment.captured",
      orderId: placed.payment.providerOrderId,
      paymentId: "pay_wh1",
      status: "PAID",
      amount: "25.00",
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => send(payload)));
    for (const r of results) expect(r.status).toBe(200);
    expect(results.filter((r) => r.body.duplicate === true)).toHaveLength(4);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(o.status).toBe("CONFIRMED");
    expect(o.paymentStatus).toBe("PAID");
    expect(await prisma.orderEvent.count({ where: { orderId: o.id, type: "PAYMENT_PAID" } })).toBe(
      1,
    );
    expect(await prisma.webhookEvent.count({ where: { eventId: "evt_parallel_1" } })).toBe(1);
    const ev = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_parallel_1" } });
    expect(ev.processedAt).not.toBeNull();
    expect(ev.error).toBeNull();
    const replay = await send(payload);
    expect(replay.body).toMatchObject({ duplicate: true });
  });

  it("rejects bad signatures with 401 and records nothing", async () => {
    const placed = await placeOrder(app);
    const bad = await send(
      { id: "evt_bad", type: "x", orderId: placed.payment.providerOrderId, status: "PAID" },
      "00ff",
    );
    expect(bad.status).toBe(401);
    expect(await prisma.webhookEvent.count({ where: { eventId: "evt_bad" } })).toBe(0);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(o.paymentStatus).toBe("PENDING");
    expect((await request(app).post("/api/v1/webhooks/mock").send({})).status).toBe(401);
    expect((await request(app).post("/api/v1/webhooks/nope").send({})).status).toBe(404);
  });

  it("records an amount mismatch, does NOT mark paid, still answers 200", async () => {
    const placed = await placeOrder(app, { price: "10.00", qty: 3 });
    const r = await send({
      id: "evt_mismatch",
      type: "payment.captured",
      orderId: placed.payment.providerOrderId,
      paymentId: "pay_m",
      status: "PAID",
      amount: "1.00",
    });
    expect(r.status).toBe(200);
    const ev = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_mismatch" } });
    expect(ev.error).toContain("amount mismatch");
    expect(ev.processedAt).not.toBeNull();
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(o.paymentStatus).toBe("PENDING");
    expect(o.status).toBe("PENDING");
  });

  it("records an unknown payment and answers 200", async () => {
    const r = await send({
      id: "evt_unknown",
      type: "payment.captured",
      orderId: "mock_order_does_not_exist",
      status: "PAID",
      amount: "1.00",
    });
    expect(r.status).toBe(200);
    const ev = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_unknown" } });
    expect(ev.error).toBe("unknown payment");
  });

  it("FAILED events only fail PENDING payments and never downgrade PAID", async () => {
    const placed = await placeOrder(app);
    await send({
      id: "evt_f1",
      type: "payment.failed",
      orderId: placed.payment.providerOrderId,
      status: "FAILED",
    });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } })).paymentStatus,
    ).toBe("FAILED");
    const paid = await placeOrder(app);
    await payViaVerify(app, paid);
    await send({
      id: "evt_f2",
      type: "payment.failed",
      orderId: paid.payment.providerOrderId,
      status: "FAILED",
    });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } })).paymentStatus,
    ).toBe("PAID");
  });
});

describe("admin payments", () => {
  it("marks a COD payment as paid (idempotent) and lists payments", async () => {
    const placed = await placeOrder(app, { provider: "MANUAL" });
    expect(placed.order.status).toBe("CONFIRMED");
    expect(placed.order.paymentStatus).toBe("PENDING");
    const r = await admin.post(`/api/v1/admin/orders/${placed.order.id}/payments/mark-paid`, {
      note: "Cash collected",
    });
    expect(r.status).toBe(200);
    expect(r.body.payment.status).toBe("PAID");
    expect(r.body.order.paymentStatus).toBe("PAID");
    const again = await admin.post(
      `/api/v1/admin/orders/${placed.order.id}/payments/mark-paid`,
      {},
    );
    expect(again.status).toBe(200);
    expect(
      await prisma.orderEvent.count({
        where: { orderId: placed.order.id, type: "PAYMENT_MARKED_PAID" },
      }),
    ).toBe(1);

    const online = await placeOrder(app);
    const bad = await admin.post(`/api/v1/admin/orders/${online.order.id}/payments/mark-paid`, {});
    expect(bad.status).toBe(409);

    const list = await admin.get("/api/v1/admin/payments?status=PAID&provider=manual");
    expect(list.status).toBe(200);
    expect(list.body.items.some((x: { id: string }) => x.id === placed.payment.id)).toBe(true);
    const byOrder = await admin.get(`/api/v1/admin/orders/${placed.order.orderNumber}/payments`);
    expect(byOrder.body.items).toHaveLength(1);
    expect(byOrder.body.items[0].refundableAmount).toBe("20.00");
    const q = await admin.get(`/api/v1/admin/payments?q=${placed.order.orderNumber}`);
    expect(q.body.total).toBe(1);
  });
});

describe("refunds", () => {
  async function paid(over: Parameters<typeof placeOrder>[1] = {}) {
    const placed = await placeOrder(app, { price: "10.00", qty: 5, ...over });
    await payViaVerify(app, placed);
    return placed; // total 50.00
  }
  const refund = (paymentId: string, body: object) =>
    admin.post(`/api/v1/admin/payments/${paymentId}/refund`, body);

  it("partially then fully refunds, capping at the remaining balance", async () => {
    const placed = await paid();
    const r1 = await refund(placed.payment.id, { amount: "20.00", reason: "damaged" });
    expect(r1.status).toBe(201);
    expect(r1.body.refund.status).toBe("PROCESSED");
    expect(r1.body.payment.status).toBe("PARTIALLY_REFUNDED");
    expect(r1.body.payment.refundableAmount).toBe("30.00");
    const over = await refund(placed.payment.id, { amount: "30.01" });
    expect(over.status).toBe(422);
    expect(over.body.error.details.refundable).toBe("30.00");
    const r2 = await refund(placed.payment.id, { amount: "30.00" });
    expect(r2.body.payment.status).toBe("REFUNDED");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(o.paymentStatus).toBe("REFUNDED");
    expect((await refund(placed.payment.id, { amount: "0.01" })).status).toBe(409);
    expect(
      await prisma.orderEvent.count({ where: { orderId: o.id, type: "REFUND_PROCESSED" } }),
    ).toBe(2);
  });

  it("parallel refunds can never exceed the payment", async () => {
    const placed = await paid();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => refund(placed.payment.id, { amount: "20.00" })),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(2); // 50.00 / 20.00 -> only two fit
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.refundedAmount.toFixed(2)).toBe("40.00");
    const sum = await prisma.refund.aggregate({
      where: { paymentId: pay.id, status: "PROCESSED" },
      _sum: { amount: true },
    });
    expect(sum._sum.amount!.toFixed(2)).toBe("40.00");
  });

  it("uses the refund id as the provider idempotency key and supports client keys", async () => {
    const placed = await paid();
    const seen: string[] = [];
    const real = mock().refundPayment.bind(mock());
    const spy = mock();
    spy.refundPayment = async (i) => {
      seen.push(i.idempotencyKey);
      return real(i);
    };
    const key = "client-key-0001";
    const [a, b] = await Promise.all([
      refund(placed.payment.id, { amount: "10.00", idempotencyKey: key }),
      refund(placed.payment.id, { amount: "10.00", idempotencyKey: key }),
    ]);
    spy.refundPayment = real;
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.refund.id).toBe(b.body.refund.id);
    expect(seen).toEqual([a.body.refund.id]);
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.refundedAmount.toFixed(2)).toBe("10.00");
  });

  it("provider failure marks the refund FAILED, releases the reservation and returns a safe 502", async () => {
    const placed = await paid();
    const spy = mock();
    const real = spy.refundPayment;
    spy.refundPayment = async () => {
      throw new Error("upstream said: secret-token-abc");
    };
    const r = await refund(placed.payment.id, { amount: "10.00" });
    spy.refundPayment = real;
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("secret-token-abc");
    const row = await prisma.refund.findFirstOrThrow({ where: { paymentId: placed.payment.id } });
    expect(row.status).toBe("FAILED");
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.refundedAmount.toFixed(2)).toBe("0.00");
    expect(pay.status).toBe("PAID");
    expect((await refund(placed.payment.id, { amount: "50.00" })).status).toBe(201);
  });

  it("manual provider refunds stay PENDING until an admin settles them", async () => {
    const placed = await placeOrder(app, { provider: "MANUAL", price: "10.00", qty: 3 });
    await admin.post(`/api/v1/admin/orders/${placed.order.id}/payments/mark-paid`, {});
    const r = await refund(placed.payment.id, { amount: "30.00" });
    expect(r.status).toBe(201);
    expect(r.body.refund.status).toBe("PENDING");
    let pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.status).toBe("PAID");
    expect(pay.refundedAmount.toFixed(2)).toBe("30.00"); // reserved
    expect((await refund(placed.payment.id, { amount: "0.01" })).status).toBe(422);
    const done = await admin.patch(`/api/v1/admin/refunds/${r.body.refund.id}`, {
      status: "PROCESSED",
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("PROCESSED");
    pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.status).toBe("REFUNDED");
    expect(
      (await admin.patch(`/api/v1/admin/refunds/${r.body.refund.id}`, { status: "FAILED" })).status,
    ).toBe(409);
    expect((await admin.get("/api/v1/admin/refunds?status=PROCESSED")).body.total).toBeGreaterThan(
      0,
    );
  });

  it("failing a pending manual refund releases its reservation", async () => {
    const placed = await placeOrder(app, { provider: "MANUAL", price: "10.00", qty: 2 });
    await admin.post(`/api/v1/admin/orders/${placed.order.id}/payments/mark-paid`, {});
    const r = await refund(placed.payment.id, { amount: "20.00" });
    await admin.patch(`/api/v1/admin/refunds/${r.body.refund.id}`, { status: "FAILED" });
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: placed.payment.id } });
    expect(pay.refundedAmount.toFixed(2)).toBe("0.00");
  });

  it("refuses unpaid payments and invalid amounts", async () => {
    const placed = await placeOrder(app);
    expect((await refund(placed.payment.id, { amount: "1.00" })).status).toBe(409);
    expect((await refund(placed.payment.id, { amount: "abc" })).status).toBe(422);
    expect((await refund("nope", { amount: "1.00" })).status).toBe(404);
  });

  it("webhook refund.processed settles the matching pending refund exactly once", async () => {
    const placed = await placeOrder(app, { provider: "MANUAL", price: "10.00", qty: 2 });
    await markPaymentStatus(ctx, { orderId: placed.order.id, status: "PAID" }, SYS);
    // MANUAL has no webhooks; simulate a provider that settles asynchronously using a MOCK payment
    const mockPlaced = await paid({ qty: 2 });
    const spy = mock();
    const real = spy.refundPayment;
    spy.refundPayment = async (i) => ({
      providerRefundId: `r_${i.idempotencyKey}`,
      status: "PENDING",
    });
    const r = await refund(mockPlaced.payment.id, { amount: "20.00" });
    spy.refundPayment = real;
    expect(r.body.refund.status).toBe("PENDING");
    const raw = JSON.stringify({
      id: "evt_refund_1",
      type: "refund.processed",
      orderId: mockPlaced.payment.providerOrderId,
      paymentId: "pay_test_1",
      status: "REFUNDED",
      amount: "20.00",
    });
    const send = () =>
      request(app)
        .post("/api/v1/webhooks/mock")
        .set("content-type", "application/json")
        .set("x-mock-signature", mock().signWebhookBody(raw))
        .send(raw);
    expect((await send()).status).toBe(200);
    expect((await send()).body.duplicate).toBe(true);
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: r.body.refund.id } });
    expect(row.status).toBe("PROCESSED");
  });
});

describe("permissions", () => {
  it("enforces the permission matrix", async () => {
    await createAdminWithRole("ORDER_MANAGER", "om-pay@test.example");
    await createAdminWithRole("SUPPORT", "sup-pay@test.example");
    await createAdminWithRole("CATALOG_MANAGER", "cm-pay@test.example");
    const om = await loginAdmin(app, "om-pay@test.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup-pay@test.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm-pay@test.example", "Another-Pass-123");
    const placed = await placeOrder(app, { provider: "MANUAL" });
    const markPaid = `/api/v1/admin/orders/${placed.order.id}/payments/mark-paid`;

    expect((await om.get("/api/v1/admin/payments")).status).toBe(200);
    expect((await sup.get("/api/v1/admin/payments")).status).toBe(200);
    expect((await cm.get("/api/v1/admin/payments")).status).toBe(403);
    expect((await sup.post(markPaid, {})).status).toBe(403);
    expect((await cm.post(markPaid, {})).status).toBe(403);
    expect((await om.post(markPaid, {})).status).toBe(200);

    const refundUrl = `/api/v1/admin/payments/${placed.payment.id}/refund`;
    expect((await sup.post(refundUrl, { amount: "1.00" })).status).toBe(403);
    expect((await cm.post(refundUrl, { amount: "1.00" })).status).toBe(403);
    expect((await om.post(refundUrl, { amount: "1.00" })).status).toBe(201);
    expect((await sup.get("/api/v1/admin/refunds")).status).toBe(200);
    expect((await sup.patch("/api/v1/admin/refunds/x", { status: "PROCESSED" })).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/payments")).status).toBe(401);
  });
});
