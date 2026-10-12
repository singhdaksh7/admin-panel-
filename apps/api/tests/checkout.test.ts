import { makeVerifyToken } from "../src/modules/customers";
import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, loginAdmin, prisma, request } from "./helpers";
import {
  addToCart,
  addr,
  checkout,
  registerCustomer,
  seedProduct,
  stockOf,
} from "./commerceHelpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let ctx: Awaited<ReturnType<typeof bootApp>>["ctx"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
beforeAll(async () => {
  ({ app, ctx } = await bootApp());
  admin = await loginAdmin(app);
});

const summary = (token: string, body: object = {}) =>
  request(app)
    .post("/api/v1/checkout/summary")
    .send({ cartToken: token, shippingAddress: addr(), ...body });

describe("summary vs create", () => {
  it("summary totals equal the created order (tax, shipping, coupon)", async () => {
    await admin.put("/api/v1/admin/settings", { tax: { mode: "EXCLUSIVE", defaultRate: 10 } });
    await admin.post("/api/v1/admin/shipping-methods", {
      code: "std",
      name: "Standard",
      type: "FLAT",
      price: "7.50",
    });
    await admin.post("/api/v1/admin/coupons", {
      code: "TOT10",
      discountType: "PERCENTAGE",
      value: "10",
    });
    const a = await seedProduct({ price: "33.33", stock: 10 });
    const b = await seedProduct({ price: "19.99", stock: 10, taxRate: "5" });
    const token = await addToCart(app, a.variant.id, 3);
    await addToCart(app, b.variant.id, 2, token);

    const body = { couponCode: "tot10", shippingMethodCode: "std" };
    const s = await summary(token, body);
    expect(s.status).toBe(200);
    const created = await checkout(app, token, { ...body, paymentProvider: "MANUAL" });
    expect(created.status).toBe(201);
    const o = created.body.order;
    for (const k of ["subtotal", "discount", "shipping", "tax", "total"])
      expect(o[k]).toBe(s.body[k]);
    expect(s.body.shipping).toBe("7.50");
    expect(s.body.discount).toBe("14.00"); // 10% of 139.97 = 13.997
  });

  it("order line snapshots sum to order totals", async () => {
    const order = await prisma.order.findFirstOrThrow({
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });
    const lineDiscount = order.items.reduce((a, i) => a + Number(i.discount) * 100, 0);
    expect(Math.round(lineDiscount)).toBe(Math.round(Number(order.discountTotal) * 100));
    const lineTax = order.items.reduce((a, i) => a + Number(i.taxAmount) * 100, 0);
    expect(Math.round(lineTax)).toBe(Math.round(Number(order.taxTotal) * 100));
    const lineTotals = order.items.reduce((a, i) => a + Number(i.lineTotal) * 100, 0);
    expect(Math.round(lineTotals + Number(order.shippingTotal) * 100)).toBe(
      Math.round(Number(order.total) * 100),
    );
  });
});

describe("snapshots and pricing integrity", () => {
  it("orders are immutable snapshots after catalog changes", async () => {
    await admin.put("/api/v1/admin/settings", { tax: { mode: "NONE" } });
    await prisma.shippingMethod.deleteMany();
    const { product, variant } = await seedProduct({ title: "Original Title", price: "50.00" });
    const token = await addToCart(app, variant.id, 2);
    const res = await checkout(app, token, { paymentProvider: "MANUAL" });
    const orderNumber = res.body.order.orderNumber as string;
    await prisma.productVariant.update({
      where: { id: variant.id },
      data: { price: "999.00", sku: "CHANGED" },
    });
    await prisma.product.update({ where: { id: product.id }, data: { title: "New Title" } });
    const o = await prisma.order.findUniqueOrThrow({
      where: { orderNumber },
      include: { items: true },
    });
    expect(o.items[0]).toMatchObject({ productTitle: "Original Title", quantity: 2 });
    expect(o.items[0]!.unitPrice.toString()).toBe("50");
    expect(o.items[0]!.sku).not.toBe("CHANGED");
    expect(o.total.toString()).toBe("100");
    const view = await request(app).get(`/api/v1/orders/${orderNumber}?email=buyer@example.com`);
    expect(view.body.items[0].title).toBe("Original Title");
    expect(view.body.items[0].unitPrice).toBe("50.00");
  });

  it("charges DB prices even if the price changes between cart and checkout; client prices ignored", async () => {
    const { variant } = await seedProduct({ price: "10.00" });
    const token = await addToCart(app, variant.id, 1);
    await prisma.productVariant.update({ where: { id: variant.id }, data: { price: "12.00" } });
    const res = await checkout(app, token, {
      paymentProvider: "MANUAL",
      price: "0.01",
      total: "0.01",
      items: [{ price: "0.01" }],
    });
    expect(res.status).toBe(201);
    expect(res.body.order.total).toBe("12.00");
  });

  it("clears the cart and the coupon after checkout", async () => {
    const { variant } = await seedProduct();
    const token = await addToCart(app, variant.id, 1);
    await checkout(app, token, { paymentProvider: "MANUAL" });
    const cart = await request(app).get("/api/v1/cart").set("x-cart-token", token);
    expect(cart.body.items).toHaveLength(0);
    expect((await checkout(app, token)).status).toBe(400); // empty cart
  });

  it("re-validates products at checkout (unpublished/out of stock)", async () => {
    const a = await seedProduct({ stock: 2 });
    const token = await addToCart(app, a.variant.id, 2);
    await prisma.inventoryItem.update({ where: { variantId: a.variant.id }, data: { onHand: 1 } });
    const r = await checkout(app, token);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("OUT_OF_STOCK");
    await prisma.inventoryItem.update({ where: { variantId: a.variant.id }, data: { onHand: 5 } });
    await prisma.product.update({ where: { id: a.product.id }, data: { status: "ARCHIVED" } });
    expect((await checkout(app, token)).status).toBe(409);
    expect((await stockOf(a.variant.id)).reserved).toBe(0);
  });
});

describe("idempotency", () => {
  it("same key + same body => same order, one reservation", async () => {
    const { variant } = await seedProduct({ stock: 10 });
    const token = await addToCart(app, variant.id, 2);
    const key = "idem-key-0001";
    const first = await checkout(app, token, { idempotencyKey: key });
    const second = await checkout(app, token, { idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.order.orderNumber).toBe(first.body.order.orderNumber);
    expect(await prisma.order.count({ where: { idempotencyKey: `checkout:${key}` } })).toBe(1);
    const inv = await stockOf(variant.id);
    expect(inv.reserved).toBe(2);
  });

  it("accepts the Idempotency-Key header, and 409s on a different body", async () => {
    const { variant } = await seedProduct({ stock: 10 });
    const token = await addToCart(app, variant.id, 1);
    const first = await checkout(app, token, {}, { "Idempotency-Key": "header-key-0001" });
    expect(first.status).toBe(201);
    const replay = await checkout(app, token, {}, { "Idempotency-Key": "header-key-0001" });
    expect(replay.body.order.orderNumber).toBe(first.body.order.orderNumber);
    const different = await checkout(
      app,
      token,
      { email: "someone-else@example.com" },
      { "Idempotency-Key": "header-key-0001" },
    );
    expect(different.status).toBe(409);
  });

  it("parallel requests with one key create exactly one order", async () => {
    const { variant } = await seedProduct({ stock: 10 });
    const token = await addToCart(app, variant.id, 1);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => checkout(app, token, { idempotencyKey: "parallel-key-1" })),
    );
    const numbers = new Set(
      rs.filter((r) => [200, 201].includes(r.status)).map((r) => r.body.order.orderNumber),
    );
    expect(numbers.size).toBe(1);
    expect(await prisma.order.count({ where: { idempotencyKey: "checkout:parallel-key-1" } })).toBe(
      1,
    );
    expect((await stockOf(variant.id)).reserved).toBe(1);
  });

  it("a failed attempt does not burn the key", async () => {
    const { variant } = await seedProduct({ stock: 1 });
    const token = await addToCart(app, variant.id, 1);
    await prisma.inventoryItem.update({ where: { variantId: variant.id }, data: { onHand: 0 } });
    const bad = await checkout(app, token, { idempotencyKey: "retry-key-0001" });
    expect(bad.status).toBe(409);
    await prisma.inventoryItem.update({ where: { variantId: variant.id }, data: { onHand: 1 } });
    const ok = await checkout(app, token, { idempotencyKey: "retry-key-0001" });
    expect(ok.status).toBe(201);
  });
});

describe("overselling", () => {
  it("15 parallel checkouts for stock 5 => exactly 5 succeed, inventory consistent", async () => {
    const { variant } = await seedProduct({ stock: 5, price: "10.00" });
    const tokens: string[] = [];
    for (let i = 0; i < 15; i++) tokens.push(await addToCart(app, variant.id, 1));
    const rs = await Promise.all(
      tokens.map((t, i) => checkout(app, t, { email: `o${i}@example.com` })),
    );
    const ok = rs.filter((r) => r.status === 201);
    const bad = rs.filter((r) => r.status !== 201);
    expect(ok).toHaveLength(5);
    expect(bad).toHaveLength(10);
    for (const r of bad) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("OUT_OF_STOCK");
    }
    const inv = await stockOf(variant.id);
    expect(inv.onHand).toBe(5);
    expect(inv.reserved).toBe(5);
    expect(
      await prisma.order.count({ where: { items: { some: { variantId: variant.id } } } }),
    ).toBe(5);
    expect(
      await prisma.inventoryMovement.count({ where: { itemId: inv.id, type: "RESERVE" } }),
    ).toBe(5);
  });

  it("COD orders commit stock immediately (onHand and reserved both drop)", async () => {
    const { variant } = await seedProduct({ stock: 5 });
    const token = await addToCart(app, variant.id, 2);
    const r = await checkout(app, token, { paymentProvider: "MANUAL" });
    expect(r.body.order.status).toBe("CONFIRMED");
    expect(r.body.paymentRequired).toBe(false);
    const inv = await stockOf(variant.id);
    expect(inv).toMatchObject({ onHand: 3, reserved: 0 });
  });

  it("backorder items can exceed stock; untracked items never touch inventory", async () => {
    const bo = await seedProduct({ stock: 1, allowBackorder: true });
    const ut = await seedProduct({ stock: 0, trackInventory: false });
    const token = await addToCart(app, bo.variant.id, 5);
    await addToCart(app, ut.variant.id, 3, token);
    const r = await checkout(app, token, { paymentProvider: "MANUAL" });
    expect(r.status).toBe(201);
    expect(await stockOf(bo.variant.id)).toMatchObject({ onHand: -4, reserved: 0 });
    expect(await stockOf(ut.variant.id)).toMatchObject({ onHand: 0, reserved: 0 });
  });
});

describe("rules: guest, account, min order, phone, numbering", () => {
  it("assigns sequential, prefixed order numbers", async () => {
    const { variant } = await seedProduct({ stock: 50 });
    const nums: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await addToCart(app, variant.id, 1);
      nums.push((await checkout(app, t)).body.order.orderNumber);
    }
    const n = nums.map((x) => Number(x.split("-")[1]));
    expect(nums[0]).toMatch(/^ORD-\d{6}$/);
    expect(n[1]).toBe(n[0]! + 1);
    expect(n[2]).toBe(n[0]! + 2);
    await admin.put("/api/v1/admin/settings", { checkout: { orderPrefix: "KC" } });
    // orderPrefix isn't in the admin settings schema yet; set it directly
    await prisma.storeSettings.update({
      where: { id: "store" },
      data: { checkout: { orderPrefix: "KC" } },
    });
    const t = await addToCart(app, variant.id, 1);
    expect((await checkout(app, t)).body.order.orderNumber).toMatch(/^KC-\d{6}$/);
    await prisma.storeSettings.update({ where: { id: "store" }, data: { checkout: {} } });
  });

  it("guest checkout can be disabled; signed-in customers still can check out", async () => {
    await admin.put("/api/v1/admin/settings", { checkout: { guestCheckout: false } });
    const { variant } = await seedProduct({ stock: 10 });
    const t = await addToCart(app, variant.id, 1);
    expect((await checkout(app, t)).status).toBe(401);
    const c = await registerCustomer(app, "member@example.com");
    const r = await c.post("/api/v1/checkout/create", { cartToken: t, shippingAddress: addr() });
    expect(r.status).toBe(201);
    expect(r.body.order.email).toBe("member@example.com");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { orderNumber: r.body.order.orderNumber } }))
        .customerId,
    ).toBe(c.id);
    await admin.put("/api/v1/admin/settings", { checkout: { guestCheckout: true } });
  });

  it("enforces minOrderAmount and requirePhone", async () => {
    await admin.put("/api/v1/admin/settings", {
      checkout: { minOrderAmount: "100.00", requirePhone: true },
    });
    const { variant } = await seedProduct({ price: "30.00", stock: 10 });
    const t = await addToCart(app, variant.id, 1);
    const low = await checkout(app, t);
    expect(low.status).toBe(422);
    expect(low.body.error.message).toMatch(/Minimum order/);
    expect((await summary(t)).status).toBe(422);
    await addToCart(app, variant.id, 3, t);
    const noPhone = await checkout(app, t, { shippingAddress: addr({ phone: null }) });
    expect(noPhone.status).toBe(422);
    expect((await checkout(app, t, { phone: "12345678" })).status).toBe(201);
    await admin.put("/api/v1/admin/settings", {
      checkout: { minOrderAmount: "0.00", requirePhone: false },
    });
  });

  it("customer checkout uses their own cart; anonymous tokens of others are not used implicitly", async () => {
    const c = await registerCustomer(app, "owncart@example.com");
    const { variant } = await seedProduct({ stock: 10 });
    await c.post("/api/v1/cart/items", { variantId: variant.id, quantity: 2 });
    const r = await c.post("/api/v1/checkout/create", { shippingAddress: addr() });
    expect(r.status).toBe(201);
    expect(r.body.order.items[0].quantity).toBe(2);
  });
});

describe("shipping methods", () => {
  it("lists by country, prices server-side, free-over logic, rejects bad codes", async () => {
    await prisma.shippingMethod.deleteMany();
    await admin.post("/api/v1/admin/shipping-methods", {
      code: "flat",
      name: "Flat",
      price: "9.00",
      countries: ["IN"],
    });
    await admin.post("/api/v1/admin/shipping-methods", {
      code: "free-over",
      name: "Free over 50",
      type: "FREE_OVER",
      price: "6.00",
      freeOverAmount: "50.00",
    });
    await admin.post("/api/v1/admin/shipping-methods", {
      code: "off",
      name: "Off",
      isActive: false,
    });
    const inList = await request(app).get("/api/v1/checkout/shipping-methods?country=IN");
    expect(inList.body.items.map((m: { code: string }) => m.code)).toEqual(["flat", "free-over"]);
    const us = await request(app).get(
      "/api/v1/checkout/shipping-methods?country=US&subtotal=60.00",
    );
    expect(us.body.items.map((m: { code: string }) => m.code)).toEqual(["free-over"]);
    expect(us.body.items[0].cost).toBe("0.00");

    const cheap = await seedProduct({ price: "20.00", stock: 10 });
    const t = await addToCart(app, cheap.variant.id, 1);
    expect((await summary(t, { shippingMethodCode: "free-over" })).body.shipping).toBe("6.00");
    expect((await summary(t, { shippingMethodCode: "flat" })).body.shipping).toBe("9.00");
    expect((await summary(t, { shippingMethodCode: "off" })).status).toBe(422);
    expect(
      (await summary(t, { shippingMethodCode: "flat", shippingAddress: addr({ country: "US" }) }))
        .status,
    ).toBe(422);
    await addToCart(app, cheap.variant.id, 2, t);
    expect((await summary(t, { shippingMethodCode: "free-over" })).body.shipping).toBe("0.00");
    // default = first applicable
    expect((await summary(t)).body.shippingMethod.code).toBe("flat");
    await prisma.shippingMethod.deleteMany();
    expect((await summary(t)).body.shipping).toBe("0.00");
  });
});

describe("tax in checkout", () => {
  it("INDIA_GST intra-state splits CGST/SGST and snapshots HSN + breakdown", async () => {
    await admin.put("/api/v1/admin/settings", {
      tax: { mode: "INDIA_GST", homeState: "Karnataka", defaultRate: 18 },
    });
    const { variant } = await seedProduct({
      price: "118.00",
      taxRate: "18",
      hsn: "4901",
      stock: 10,
    });
    const t = await addToCart(app, variant.id, 1);
    const intra = await checkout(app, t, { paymentProvider: "MANUAL" });
    expect(intra.body.order.tax).toBe("18.00");
    expect(intra.body.order.total).toBe("118.00"); // inclusive
    expect(intra.body.order.taxBreakdown.lines.map((l: { name: string }) => l.name)).toEqual([
      "CGST",
      "SGST",
    ]);
    const item = await prisma.orderItem.findFirstOrThrow({
      where: {
        orderId: (
          await prisma.order.findUniqueOrThrow({
            where: { orderNumber: intra.body.order.orderNumber },
          })
        ).id,
      },
    });
    expect(item.hsnCode).toBe("4901");
    expect(item.taxRate.toString()).toBe("18");

    const t2 = await addToCart(app, variant.id, 1);
    const inter = await checkout(app, t2, {
      paymentProvider: "MANUAL",
      shippingAddress: addr({ state: "Maharashtra" }),
    });
    expect(inter.body.order.taxBreakdown.lines.map((l: { name: string }) => l.name)).toEqual([
      "IGST",
    ]);
    await admin.put("/api/v1/admin/settings", { tax: { mode: "NONE" } });
  });
});

describe("payment initiation", () => {
  it("returns provider clientPayload and keeps the order PENDING with a PENDING payment", async () => {
    ctx.providers.payment.MOCK = {
      key: "MOCK",
      createPayment: async (i) => ({
        providerOrderId: `mock_${i.orderNumber}`,
        clientPayload: { orderRef: `mock_${i.orderNumber}`, amount: i.amount },
        status: "PENDING",
      }),
      verifyPayment: async () => ({ verified: true, providerPaymentId: "p", status: "PAID" }),
      handleWebhook: async () => ({ eventId: "e", type: "t" }),
      refundPayment: async () => ({ providerRefundId: "r", status: "PROCESSED" }),
    };
    const { variant } = await seedProduct({ price: "25.00", stock: 5 });
    const t = await addToCart(app, variant.id, 1);
    const r = await checkout(app, t);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      paymentRequired: true,
      paymentProvider: "MOCK",
      providerAvailable: true,
    });
    expect(r.body.clientPayload).toMatchObject({ amount: "25.00" });
    expect(r.body.order.status).toBe("PENDING");
    const pay = await prisma.payment.findFirstOrThrow({
      where: { order: { orderNumber: r.body.order.orderNumber } },
    });
    expect(pay).toMatchObject({
      provider: "MOCK",
      status: "PENDING",
      providerOrderId: `mock_${r.body.order.orderNumber}`,
    });
    delete ctx.providers.payment.MOCK;
  });

  it("reports providerAvailable:false when no provider is registered, rejects unknown providers, zero total auto-confirms", async () => {
    const { variant } = await seedProduct({ price: "25.00", stock: 5 });
    const t = await addToCart(app, variant.id, 1);
    const r = await checkout(app, t);
    expect(r.body).toMatchObject({
      paymentRequired: true,
      providerAvailable: false,
      clientPayload: null,
    });
    expect(
      (await checkout(app, await addToCart(app, variant.id, 1), { paymentProvider: "STRIPE" }))
        .status,
    ).toBe(422);

    await admin.post("/api/v1/admin/coupons", {
      code: "FREE100",
      discountType: "PERCENTAGE",
      value: "100",
    });
    const t2 = await addToCart(app, variant.id, 1);
    const free = await checkout(app, t2, { couponCode: "free100" });
    expect(free.body.order).toMatchObject({
      total: "0.00",
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    expect(free.body.paymentRequired).toBe(false);
  });
});

describe("public order lookup", () => {
  it("requires the matching email or the owning session; uniform 404 otherwise", async () => {
    const { variant } = await seedProduct({ stock: 5 });
    const t = await addToCart(app, variant.id, 1);
    const r = await checkout(app, t, { email: "Lookup@Example.com", paymentProvider: "MANUAL" });
    const n = r.body.order.orderNumber as string;
    expect((await request(app).get(`/api/v1/orders/${n}?email=lookup@example.com`)).status).toBe(
      200,
    );
    const wrong = await request(app).get(`/api/v1/orders/${n}?email=evil@example.com`);
    const none = await request(app).get(`/api/v1/orders/${n}`);
    const ghost = await request(app).get(`/api/v1/orders/ORD-999999?email=evil@example.com`);
    for (const x of [wrong, none, ghost]) expect(x.status).toBe(404);
    expect(wrong.body.error.message).toBe(ghost.body.error.message);
    expect(
      JSON.stringify((await request(app).get(`/api/v1/orders/${n}?email=lookup@example.com`)).body),
    ).not.toMatch(/actorId|providerOrderId/);

    const owner = await registerCustomer(app, "lookup@example.com");
    const ownerRow = await prisma.customer.findUniqueOrThrow({
      where: { email: "lookup@example.com" },
    });
    await request(app) // mailbox ownership proven -> guest order is attached
      .post("/api/v1/account/verify-email")
      .send({ token: makeVerifyToken(process.env.SESSION_SECRET!, ownerRow.id, ownerRow.email) });
    expect((await owner.get(`/api/v1/orders/${n}`)).status).toBe(200);
    const stranger = await registerCustomer(app, "stranger@example.com");
    expect((await stranger.get(`/api/v1/orders/${n}`)).status).toBe(404);
  });
});
