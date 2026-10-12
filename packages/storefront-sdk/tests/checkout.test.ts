import { describe, expect, it } from "vitest";
import { createMemoryCartStorage, hasNextPage, paginate } from "../src";
import { apiError, emptyCart, json, setup } from "./helpers";

const addr = {
  fullName: "A B",
  line1: "1 Main St",
  city: "Town",
  postalCode: "12345",
  country: "US",
};
const created = {
  order: { orderNumber: "KC-100001" },
  paymentRequired: false,
  paymentProvider: "MANUAL",
  providerAvailable: false,
  clientPayload: null,
};

describe("checkout", () => {
  it("summary posts the address and sends the cart token header", async () => {
    const { commerce, calls } = setup(() => json({ total: "10.00" }), {
      cartStorage: createMemoryCartStorage("tok-checkout-01"),
    });
    await commerce.checkout.summary({ shippingAddress: addr, shippingMethodCode: "flat" });
    expect(calls[0]!.path).toBe("/api/v1/checkout/summary");
    expect(calls[0]!.headers["x-cart-token"]).toBe("tok-checkout-01");
    expect(calls[0]!.body).toEqual({ shippingAddress: addr, shippingMethodCode: "flat" });
  });

  it("shippingMethods unwraps items and forwards country/subtotal", async () => {
    const { commerce, calls } = setup(() => json({ items: [{ code: "flat" }] }));
    const m = await commerce.checkout.shippingMethods({ country: "IN", subtotal: "99.00" });
    expect(m).toEqual([{ code: "flat" }]);
    expect(calls[0]!.search.get("country")).toBe("IN");
    expect(calls[0]!.search.get("subtotal")).toBe("99.00");
  });

  it("create generates an Idempotency-Key header", async () => {
    const { commerce, calls } = setup(() => json(created, 201));
    const r = await commerce.checkout.create({ email: "a@b.co", shippingAddress: addr });
    expect(r.order.orderNumber).toBe("KC-100001");
    const key = calls[0]!.headers["idempotency-key"]!;
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ email: "a@b.co", shippingAddress: addr });
  });

  it("reuses the same key when the same call is retried after a failure", async () => {
    let n = 0;
    const { commerce, calls } = setup(() => {
      n++;
      if (n === 1) throw new TypeError("connection reset");
      if (n === 2) return apiError(503, "INTERNAL_ERROR");
      return json(created, 201);
    });
    const input = { email: "a@b.co", shippingAddress: addr };
    await expect(commerce.checkout.create(input)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(commerce.checkout.create({ ...input })).rejects.toMatchObject({ status: 503 });
    await commerce.checkout.create(input);
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(1);
    expect(calls).toHaveLength(3); // the SDK never auto-retries the POST
  });

  it("uses a fresh key for a different order and after a success", async () => {
    const { commerce, calls } = setup(() => json(created, 201));
    const input = { email: "a@b.co", shippingAddress: addr };
    await commerce.checkout.create(input);
    await commerce.checkout.create(input);
    await commerce.checkout.create({ ...input, email: "other@b.co" });
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("accepts a caller-supplied key", async () => {
    const { commerce, calls } = setup(() => json(created, 201));
    await commerce.checkout.create(
      { email: "a@b.co", shippingAddress: addr },
      { idempotencyKey: "my-own-key-123" },
    );
    expect(calls[0]!.headers["idempotency-key"]).toBe("my-own-key-123");
  });

  it("surfaces payment client payloads untouched", async () => {
    const payload = { keyId: "rzp_test", providerOrderId: "order_1", amount: "10.00" };
    const { commerce } = setup(() =>
      json(
        { ...created, paymentRequired: true, paymentProvider: "RAZORPAY", clientPayload: payload },
        201,
      ),
    );
    const r = await commerce.checkout.create({ email: "a@b.co", shippingAddress: addr });
    expect(r.clientPayload).toEqual(payload);
  });

  it("cart token survives checkout (cart is emptied server-side, token stays)", async () => {
    const { commerce } = setup((c) =>
      c.path.endsWith("/cart") ? json(emptyCart("tok-after-order1")) : json(created, 201),
    );
    await commerce.cart.get();
    await commerce.checkout.create({ email: "a@b.co", shippingAddress: addr });
    expect(await commerce.cart.getToken()).toBe("tok-after-order1");
  });
});

describe("pagination", () => {
  const page = (n: number, total = 5) => ({
    items: [{ id: `p${n}a` }, { id: `p${n}b` }],
    page: n,
    pageSize: 2,
    total: 6,
    totalPages: total,
  });

  it("hasNextPage compares page with totalPages", () => {
    expect(hasNextPage({ page: 1, totalPages: 2 })).toBe(true);
    expect(hasNextPage({ page: 2, totalPages: 2 })).toBe(false);
  });

  it("listAll iterates every page lazily", async () => {
    const { commerce, calls } = setup((c) => json(page(Number(c.search.get("page") ?? 1), 3)));
    const ids: string[] = [];
    for await (const p of commerce.products.listAll({ category: "x", pageSize: 2 })) ids.push(p.id);
    expect(ids).toEqual(["p1a", "p1b", "p2a", "p2b", "p3a", "p3b"]);
    expect(calls.map((c) => c.search.get("page"))).toEqual(["1", "2", "3"]);
    expect(calls[0]!.search.get("category")).toBe("x");
  });

  it("listAll stops early when the consumer breaks and honours maxPages/startPage", async () => {
    const { commerce, calls } = setup((c) => json(page(Number(c.search.get("page") ?? 1), 10)));
    for await (const p of commerce.products.listAll({})) {
      if (p.id === "p1b") break;
    }
    expect(calls).toHaveLength(1);
    const out: string[] = [];
    for await (const p of commerce.products.listAll({ page: 4 }, { maxPages: 2 })) out.push(p.id);
    expect(out).toEqual(["p4a", "p4b", "p5a", "p5b"]);
  });

  it("paginate() terminates on an empty page", async () => {
    const out: number[] = [];
    for await (const n of paginate(async () => ({
      items: [] as number[],
      page: 1,
      pageSize: 1,
      total: 0,
      totalPages: 9,
    })))
      out.push(n);
    expect(out).toEqual([]);
  });
});
