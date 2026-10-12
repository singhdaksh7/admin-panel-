import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import {
  addToCart,
  checkout,
  registerCustomer,
  seedCategory,
  seedProduct,
  stockOf,
} from "./commerceHelpers";
import { validateCoupon } from "../src/modules/coupons/service";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
beforeAll(async () => {
  ({ app } = await bootApp());
  admin = await loginAdmin(app);
});

const mk = (over: Record<string, unknown> = {}) =>
  admin.post("/api/v1/admin/coupons", {
    code: "save10",
    discountType: "PERCENTAGE",
    value: "10",
    ...over,
  });

const lines = (...totals: Array<[string, string | null, number]>) =>
  totals.map(([productId, categoryId, lineTotalMinor]) => ({
    productId,
    categoryId,
    lineTotalMinor,
  }));

async function reason(code: string, ls: ReturnType<typeof lines>, extra: object = {}) {
  try {
    await validateCoupon(prisma, {
      code,
      lines: ls,
      subtotalMinor: ls.reduce((a, l) => a + l.lineTotalMinor, 0),
      ...extra,
    });
    return "OK";
  } catch (e) {
    return (e as { details: { reason: string } }).details.reason;
  }
}

describe("coupon admin CRUD", () => {
  it("creates (upper-cased, unique), reads, updates, deletes", async () => {
    const c = await mk({ description: "Ten off" });
    expect(c.status).toBe(201);
    expect(c.body.code).toBe("SAVE10");
    expect((await mk()).status).toBe(409);
    const get = await admin.get(`/api/v1/admin/coupons/${c.body.id}`);
    expect(get.body.value).toBe("10.00");
    const upd = await admin.patch(`/api/v1/admin/coupons/${c.body.id}`, {
      value: "15",
      maxDiscount: "50.00",
    });
    expect(upd.body).toMatchObject({ value: "15.00", maxDiscount: "50.00" });
    expect((await admin.get("/api/v1/admin/coupons?q=save")).body.total).toBe(1);
    expect((await admin.del(`/api/v1/admin/coupons/${c.body.id}`)).status).toBe(200);
    expect((await admin.get(`/api/v1/admin/coupons/${c.body.id}`)).status).toBe(404);
  });

  it("validates input", async () => {
    expect((await mk({ code: "x" })).status).toBe(422);
    expect((await mk({ code: "PCT", value: "150" })).status).toBe(422);
    expect((await mk({ code: "ZERO", value: "0" })).status).toBe(422);
    expect((await mk({ code: "BAD", value: "abc" })).status).toBe(422);
    expect((await mk({ code: "DATES", startsAt: "2030-01-02", endsAt: "2030-01-01" })).status).toBe(
      422,
    );
  });

  it("enforces permissions (read for ORDER_MANAGER, write for ADMIN only; none for CATALOG_MANAGER)", async () => {
    await createAdminWithRole("ORDER_MANAGER", "om-c@test.example");
    await createAdminWithRole("CATALOG_MANAGER", "cm-c@test.example");
    const om = await loginAdmin(app, "om-c@test.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm-c@test.example", "Another-Pass-123");
    expect((await om.get("/api/v1/admin/coupons")).status).toBe(200);
    expect(
      (await om.post("/api/v1/admin/coupons", { code: "NOPE1", discountType: "FIXED", value: "1" }))
        .status,
    ).toBe(403);
    expect((await cm.get("/api/v1/admin/coupons")).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/coupons")).status).toBe(401);
  });

  it("refuses to hard-delete redeemed coupons", async () => {
    const { variant } = await seedProduct({ price: "100.00" });
    const c = await mk({ code: "USED1" });
    const token = await addToCart(app, variant.id, 1);
    const r = await checkout(app, token, { couponCode: "used1", paymentProvider: "MANUAL" });
    expect(r.status).toBe(201);
    expect((await admin.del(`/api/v1/admin/coupons/${c.body.id}`)).status).toBe(409);
  });
});

describe("validateCoupon rules", () => {
  it("reports precise reasons", async () => {
    const p = await seedProduct();
    const L = lines([p.product.id, null, 10000]);
    expect(await reason("NOPE", L)).toBe("NOT_FOUND");

    await mk({ code: "OFF1", isActive: false });
    expect(await reason("off1", L)).toBe("INACTIVE");

    await mk({ code: "FUTURE", startsAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(await reason("FUTURE", L)).toBe("NOT_STARTED");

    await mk({ code: "PAST", endsAt: new Date(Date.now() - 1000).toISOString() });
    expect(await reason("PAST", L)).toBe("EXPIRED");

    await mk({ code: "MIN50", minOrderAmount: "150.00" });
    expect(await reason("MIN50", L)).toBe("MIN_ORDER_NOT_MET");
    expect(await reason("MIN50", lines([p.product.id, null, 15000]))).toBe("OK");

    const other = await seedProduct();
    await mk({ code: "ONLYP", productIds: [other.product.id] });
    expect(await reason("ONLYP", L)).toBe("NOT_APPLICABLE");

    const c = await mk({ code: "FULL", usageLimit: 1 });
    await prisma.coupon.update({ where: { id: c.body.id }, data: { usedCount: 1 } });
    expect(await reason("FULL", L)).toBe("USAGE_LIMIT_REACHED");
  });

  it("enforces perCustomerLimit by customer id and by email", async () => {
    const p = await seedProduct();
    const L = lines([p.product.id, null, 10000]);
    const c = await mk({ code: "ONCE", perCustomerLimit: 1 });
    await prisma.couponRedemption.create({
      data: { couponId: c.body.id, orderId: "o1", email: "a@x.com", amount: "1.00" },
    });
    expect(await reason("ONCE", L, { email: "A@x.com" })).toBe("PER_CUSTOMER_LIMIT_REACHED");
    expect(await reason("ONCE", L, { email: "b@x.com" })).toBe("OK");
    await prisma.couponRedemption.create({
      data: { couponId: c.body.id, orderId: "o2", customerId: "cust1", amount: "1.00" },
    });
    expect(await reason("ONCE", L, { customerId: "cust1" })).toBe("PER_CUSTOMER_LIMIT_REACHED");
  });

  it("computes percentage, fixed, caps and eligible-only discounts", async () => {
    const a = await seedProduct();
    const b = await seedProduct();
    await mk({ code: "PCT20", value: "20", maxDiscount: "25.00" });
    const r = await validateCoupon(prisma, {
      code: "pct20",
      lines: lines([a.product.id, null, 10000], [b.product.id, null, 20000]),
      subtotalMinor: 30000,
    });
    expect(r.discountMinor).toBe(2500); // 20% of 300 = 60, capped at 25
    expect(r.lineDiscounts.reduce((x, y) => x + y, 0)).toBe(2500);

    await mk({ code: "FIX500", discountType: "FIXED", value: "500.00" });
    const f = await validateCoupon(prisma, {
      code: "FIX500",
      lines: lines([a.product.id, null, 30000]),
      subtotalMinor: 30000,
    });
    expect(f.discountMinor).toBe(30000); // can't exceed the eligible subtotal

    await mk({ code: "ELIG", discountType: "PERCENTAGE", value: "50", productIds: [b.product.id] });
    const e = await validateCoupon(prisma, {
      code: "ELIG",
      lines: lines([a.product.id, null, 10000], [b.product.id, null, 20000]),
      subtotalMinor: 30000,
    });
    expect(e.eligibleSubtotalMinor).toBe(20000);
    expect(e.discountMinor).toBe(10000);
    expect(e.lineDiscounts).toEqual([0, 10000]);
  });

  it("category restriction includes descendant categories", async () => {
    const root = await seedCategory("Books");
    const child = await seedCategory("Fiction", root.id);
    const grandchild = await seedCategory("Scifi", child.id);
    const unrelated = await seedCategory("Toys");
    await mk({ code: "BOOKS", categoryIds: [root.id] });
    const inBooks = await seedProduct({ categoryId: grandchild.id });
    const inToys = await seedProduct({ categoryId: unrelated.id });
    expect(await reason("BOOKS", lines([inBooks.product.id, grandchild.id, 5000]))).toBe("OK");
    expect(await reason("BOOKS", lines([inToys.product.id, unrelated.id, 5000]))).toBe(
      "NOT_APPLICABLE",
    );
  });
});

describe("coupon in cart/checkout", () => {
  it("applies via the cart, reflects in totals, and can be removed", async () => {
    const { variant } = await seedProduct({ price: "100.00" });
    await mk({ code: "CART10" });
    const token = await addToCart(app, variant.id, 1);
    const bad = await request(app)
      .post("/api/v1/cart/coupon")
      .set("x-cart-token", token)
      .send({ code: "nope" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.reason).toBe("NOT_FOUND");
    const ok = await request(app)
      .post("/api/v1/cart/coupon")
      .set("x-cart-token", token)
      .send({ code: "cart10" });
    expect(ok.body).toMatchObject({ couponCode: "CART10", discount: "10.00", total: "90.00" });
    const rm = await request(app).delete("/api/v1/cart/coupon").set("x-cart-token", token);
    expect(rm.body).toMatchObject({ couponCode: null, discount: "0.00", total: "100.00" });
  });

  it("respects features.coupons=false", async () => {
    const { variant } = await seedProduct({ price: "100.00" });
    await mk({ code: "FEAT10" });
    await admin.put("/api/v1/admin/settings", { features: { coupons: false } });
    const token = await addToCart(app, variant.id, 1);
    const r = await request(app)
      .post("/api/v1/cart/coupon")
      .set("x-cart-token", token)
      .send({ code: "feat10" });
    expect(r.status).toBe(422);
    expect(r.body.error.details.reason).toBe("DISABLED");
    await admin.put("/api/v1/admin/settings", { features: { coupons: true } });
  });

  it("usage cap is race-safe: 8 parallel checkouts on a 3-use coupon => exactly 3 orders", async () => {
    const { variant } = await seedProduct({ price: "20.00", stock: 50 });
    const c = await mk({ code: "RACE3", usageLimit: 3, discountType: "FIXED", value: "5" });
    const tokens: string[] = [];
    for (let i = 0; i < 8; i++) tokens.push(await addToCart(app, variant.id, 1));
    const results = await Promise.all(
      tokens.map((t, i) =>
        checkout(app, t, {
          couponCode: "RACE3",
          email: `race${i}@example.com`,
          paymentProvider: "MANUAL",
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(3);
    for (const r of results.filter((x) => x.status !== 201))
      expect(r.body.error.details.reason).toBe("USAGE_LIMIT_REACHED");
    const fresh = await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.id } });
    expect(fresh.usedCount).toBe(3);
    expect(await prisma.couponRedemption.count({ where: { couponId: c.body.id } })).toBe(3);
    // failed attempts rolled back their reservation: only the 3 COD orders (committed) changed stock
    const inv = await stockOf(variant.id);
    expect(inv.onHand).toBe(47);
    expect(inv.reserved).toBe(0);
  });

  it("per-customer limit holds under parallel checkouts by the same customer", async () => {
    const { variant } = await seedProduct({ price: "20.00", stock: 50 });
    await mk({ code: "ONEEACH", perCustomerLimit: 1, discountType: "FIXED", value: "5" });
    const cust = await registerCustomer(app, "limit@example.com");
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) tokens.push(await addToCart(app, variant.id, 1));
    const results = await Promise.all(
      tokens.map((t) =>
        cust.agent
          .post("/api/v1/checkout/create")
          .set("x-csrf-token", cust.csrf)
          .send({
            cartToken: t,
            couponCode: "ONEEACH",
            paymentProvider: "MANUAL",
            shippingAddress: {
              fullName: "A",
              line1: "1",
              city: "c",
              postalCode: "1",
              country: "IN",
            },
          }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("cancelling an order gives the coupon use back", async () => {
    const { variant } = await seedProduct({ price: "20.00", stock: 5 });
    const c = await mk({ code: "REFUNDUSE", usageLimit: 1, discountType: "FIXED", value: "5" });
    const token = await addToCart(app, variant.id, 1);
    const r = await checkout(app, token, { couponCode: "REFUNDUSE" }); // default MOCK provider => stays PENDING
    expect(r.status).toBe(201);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(1);
    const o = await prisma.order.findUniqueOrThrow({
      where: { orderNumber: r.body.order.orderNumber },
    });
    expect((await admin.post(`/api/v1/admin/orders/${o.id}/cancel`, {})).status).toBe(200);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(0);
    expect(await prisma.couponRedemption.count({ where: { couponId: c.body.id } })).toBe(0);
  });
});
