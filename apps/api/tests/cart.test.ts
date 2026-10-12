import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, prisma, request } from "./helpers";
import { addToCart, registerCustomer, seedProduct } from "./commerceHelpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
beforeAll(async () => {
  ({ app } = await bootApp());
});

const withToken = (r: request.Test, t: string) => r.set("x-cart-token", t);

describe("cart", () => {
  it("anonymous cart: add, update, remove with DB prices and a token", async () => {
    const { variant } = await seedProduct({ price: "12.50", stock: 10 });
    const res = await request(app).post("/api/v1/cart/items").send({ variantId: variant.id, quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/kc_cart=.*HttpOnly/i);
    const token = res.body.token as string;
    expect(res.body.items[0]).toMatchObject({ unitPrice: "12.50", quantity: 2, lineTotal: "25.00" });
    expect(res.body.subtotal).toBe("25.00");
    expect(res.body.total).toBe("25.00");
    expect(res.body.shippingExcluded).toBe(true);

    // adding again increments
    const again = await withToken(request(app).post("/api/v1/cart/items"), token).send({ variantId: variant.id, quantity: 1 });
    expect(again.body.items[0].quantity).toBe(3);

    const patched = await withToken(request(app).patch(`/api/v1/cart/items/${variant.id}`), token).send({ quantity: 5 });
    expect(patched.body.items[0].quantity).toBe(5);
    expect(patched.body.subtotal).toBe("62.50");

    const got = await withToken(request(app).get("/api/v1/cart"), token);
    expect(got.body.itemCount).toBe(5);

    const removed = await withToken(request(app).delete(`/api/v1/cart/items/${variant.id}`), token);
    expect(removed.body.items).toHaveLength(0);
  });

  it("GET without a cart returns an empty cart and creates nothing", async () => {
    const before = await prisma.cart.count();
    const res = await request(app).get("/api/v1/cart");
    expect(res.body).toMatchObject({ items: [], total: "0.00", token: null });
    expect(await prisma.cart.count()).toBe(before);
  });

  it("ignores client-supplied prices", async () => {
    const { variant } = await seedProduct({ price: "40.00" });
    const res = await request(app)
      .post("/api/v1/cart/items")
      .send({ variantId: variant.id, quantity: 1, price: "0.01", unitPrice: "0.01" });
    expect(res.status).toBe(201);
    expect(res.body.items[0].unitPrice).toBe("40.00");
    expect(res.body.total).toBe("40.00");
  });

  it("validates quantity bounds, variant existence, status and stock", async () => {
    const { variant } = await seedProduct({ stock: 3 });
    const post = (b: object) => request(app).post("/api/v1/cart/items").send(b);
    expect((await post({ variantId: variant.id, quantity: 0 })).status).toBe(422);
    expect((await post({ variantId: variant.id, quantity: 100 })).status).toBe(422);
    expect((await post({ variantId: variant.id, quantity: -1 })).status).toBe(422);
    expect((await post({ variantId: variant.id, quantity: 1.5 })).status).toBe(422);
    expect((await post({ variantId: "nope", quantity: 1 })).status).toBe(404);
    const over = await post({ variantId: variant.id, quantity: 4 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("OUT_OF_STOCK");

    const draft = await seedProduct({ status: "DRAFT" });
    expect((await post({ variantId: draft.variant.id, quantity: 1 })).status).toBe(409);
    const inactive = await seedProduct({ variantActive: false });
    expect((await post({ variantId: inactive.variant.id, quantity: 1 })).status).toBe(409);
    const oos = await seedProduct({ stock: 0 });
    expect((await post({ variantId: oos.variant.id, quantity: 1 })).status).toBe(409);
  });

  it("allows backorder / untracked items beyond stock but caps at 99", async () => {
    const bo = await seedProduct({ stock: 0, allowBackorder: true });
    const r = await request(app).post("/api/v1/cart/items").send({ variantId: bo.variant.id, quantity: 50 });
    expect(r.status).toBe(201);
    const over = await withToken(request(app).post("/api/v1/cart/items"), r.body.token).send({ variantId: bo.variant.id, quantity: 60 });
    expect(over.status).toBe(422);
  });

  it("flags lines that became unavailable and excludes them from totals", async () => {
    const a = await seedProduct({ price: "10.00" });
    const b = await seedProduct({ price: "5.00" });
    const token = await addToCart(app, a.variant.id, 1);
    await addToCart(app, b.variant.id, 1, token);
    await prisma.product.update({ where: { id: b.product.id }, data: { status: "ARCHIVED" } });
    const res = await withToken(request(app).get("/api/v1/cart"), token);
    expect(res.body.total).toBe("10.00");
    expect(res.body.warnings.map((w: { variantId: string }) => w.variantId)).toContain(b.variant.id);
    expect(res.body.unavailableItems).toHaveLength(1);
  });

  it("does not let an anonymous caller use a customer's cart token", async () => {
    const c = await registerCustomer(app, "cartowner@example.com");
    const { variant } = await seedProduct();
    await c.post("/api/v1/cart/items", { variantId: variant.id, quantity: 1 });
    const cart = await prisma.cart.findFirstOrThrow({ where: { customerId: c.id } });
    const res = await withToken(request(app).get("/api/v1/cart"), cart.token);
    expect(res.body.items).toHaveLength(0);
  });

  it("slides expiry on use", async () => {
    const { variant } = await seedProduct();
    const token = await addToCart(app, variant.id, 1);
    await prisma.cart.update({ where: { token }, data: { expiresAt: new Date(Date.now() + 1000 * 60) } });
    await withToken(request(app).get("/api/v1/cart"), token);
    const c = await prisma.cart.findUniqueOrThrow({ where: { token } });
    expect(c.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
    await prisma.cart.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await withToken(request(app).get("/api/v1/cart"), token)).body.items).toHaveLength(0);
  });

  it("merges an anonymous cart into the customer cart on login", async () => {
    const x = await seedProduct({ stock: 5 });
    const y = await seedProduct({ stock: 5 });
    const c = await registerCustomer(app, "merge@example.com");
    // existing customer cart: x qty 2
    await c.post("/api/v1/cart/items", { variantId: x.variant.id, quantity: 2 });
    // anonymous cart: x qty 2, y qty 1
    const token = await addToCart(app, x.variant.id, 2);
    await addToCart(app, y.variant.id, 1, token);

    const noCsrf = await c.agent.post("/api/v1/cart/merge").send({ cartToken: token });
    expect(noCsrf.status).toBe(403);
    const merged = await c.post("/api/v1/cart/merge", { cartToken: token });
    expect(merged.status).toBe(200);
    const byVariant = Object.fromEntries(merged.body.items.map((i: { variantId: string; quantity: number }) => [i.variantId, i.quantity]));
    expect(byVariant[x.variant.id]).toBe(4);
    expect(byVariant[y.variant.id]).toBe(1);
    expect(await prisma.cart.count({ where: { token } })).toBe(0);
    // merge requires auth
    expect((await request(app).post("/api/v1/cart/merge").send({ cartToken: token })).status).toBe(401);
  });

  it("merge clamps to available stock", async () => {
    const x = await seedProduct({ stock: 3 });
    const c = await registerCustomer(app, "merge2@example.com");
    await c.post("/api/v1/cart/items", { variantId: x.variant.id, quantity: 2 });
    const token = await addToCart(app, x.variant.id, 3);
    const merged = await c.post("/api/v1/cart/merge", { cartToken: token });
    expect(merged.body.items[0].quantity).toBe(3);
  });

  it("an authenticated cookie request without CSRF is treated as anonymous (no identity abuse)", async () => {
    const c = await registerCustomer(app, "csrfcart@example.com");
    const { variant } = await seedProduct();
    const res = await c.agent.post("/api/v1/cart/items").send({ variantId: variant.id, quantity: 1 });
    expect(res.status).toBe(201);
    expect(await prisma.cart.count({ where: { customerId: c.id } })).toBe(0);
    const ok = await c.post("/api/v1/cart/items", { variantId: variant.id, quantity: 1 });
    expect(ok.status).toBe(201);
    expect(await prisma.cart.count({ where: { customerId: c.id } })).toBe(1);
  });
});
