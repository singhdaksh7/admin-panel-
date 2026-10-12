import { describe, expect, it, vi } from "vitest";
import { createCommerceClient, createMemoryCartStorage, type CartStorage } from "../src";
import { apiError, customer, emptyCart, json, setup, type Call } from "./helpers";

const session = (csrf = "csrf-1") => json({ customer, csrfToken: csrf });

describe("cart token handling", () => {
  it("persists the token from responses and sends it as X-Cart-Token", async () => {
    const { commerce, calls } = setup((c) =>
      c.method === "POST"
        ? json(emptyCart("tok-1234567890"), 201)
        : json(emptyCart("tok-1234567890")),
    );
    await commerce.cart.add({ variantId: "v1", quantity: 2 });
    expect(calls[0]!.headers["x-cart-token"]).toBeUndefined();
    expect(calls[0]!.body).toEqual({ variantId: "v1", quantity: 2 });
    expect(await commerce.cart.getToken()).toBe("tok-1234567890");
    await commerce.cart.get();
    expect(calls[1]!.headers["x-cart-token"]).toBe("tok-1234567890");
  });

  it("defaults quantity to 1 and refreshes the token when the server rotates it", async () => {
    let n = 0;
    const { commerce, calls } = setup(() => json(emptyCart(`tok-aaaaaaaa${++n}`)));
    await commerce.cart.add({ variantId: "v" });
    await commerce.cart.add({ variantId: "v" });
    expect(calls[0]!.body).toEqual({ variantId: "v", quantity: 1 });
    expect(calls[1]!.headers["x-cart-token"]).toBe("tok-aaaaaaaa1");
    expect(await commerce.cart.getToken()).toBe("tok-aaaaaaaa2");
  });

  it("keeps the stored token when the API answers with token: null", async () => {
    const storage = createMemoryCartStorage("tok-existing-12");
    const { commerce } = setup(() => json(emptyCart(null)), { cartStorage: storage });
    await commerce.cart.get();
    expect(await storage.get()).toBe("tok-existing-12");
  });

  it("supports pluggable (async) cart storage", async () => {
    const store: Record<string, string> = {};
    const storage: CartStorage = {
      get: async () => store.t ?? null,
      set: async (t) => {
        store.t = t;
      },
      remove: async () => {
        delete store.t;
      },
    };
    const { commerce, calls } = setup(() => json(emptyCart("tok-pluggable1")), {
      cartStorage: storage,
    });
    await commerce.cart.get();
    expect(store.t).toBe("tok-pluggable1");
    const second = setup(() => json(emptyCart("tok-pluggable1")), { cartStorage: storage });
    await second.commerce.cart.get();
    expect(second.calls[0]!.headers["x-cart-token"]).toBe("tok-pluggable1");
    expect(calls).toHaveLength(1);
  });

  it("survives a throwing storage implementation", async () => {
    const storage: CartStorage = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => {
        throw new Error("blocked");
      },
      remove: () => {
        throw new Error("blocked");
      },
    };
    const { commerce, calls } = setup(() => json(emptyCart("tok-memoryonly1")), {
      cartStorage: storage,
    });
    await commerce.cart.get();
    await commerce.cart.get();
    expect(calls[1]!.headers["x-cart-token"]).toBe("tok-memoryonly1");
  });

  it("SSR: the default storage falls back to memory and instances do not share carts", async () => {
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe("undefined");
    const fetchA = vi.fn(async () => json(emptyCart("tok-instance-a1")));
    const fetchB = vi.fn(async (_u: string, _i?: RequestInit) => json(emptyCart(null)));
    const a = createCommerceClient({ baseUrl: "http://x", fetch: fetchA as never });
    const b = createCommerceClient({ baseUrl: "http://x", fetch: fetchB as never });
    await a.cart.get();
    await b.cart.get();
    expect(await a.cart.getToken()).toBe("tok-instance-a1");
    expect(await b.cart.getToken()).toBeNull();
    const headers = fetchB.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["X-Cart-Token"]).toBeUndefined();
  });

  it("uses localStorage by default when it exists", async () => {
    const mem: Record<string, string> = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => void (mem[k] = v),
      removeItem: (k: string) => void delete mem[k],
    };
    try {
      const f = vi.fn(async () => json(emptyCart("tok-localstore1")));
      const c = createCommerceClient({ baseUrl: "http://x", fetch: f as never });
      await c.cart.get();
      expect(mem["kash.cartToken"]).toBe("tok-localstore1");
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("cart mutations use the right verbs and paths", async () => {
    const { commerce, calls } = setup(() => json(emptyCart("tok-verbs-0001")));
    await commerce.cart.update("v 1", 3);
    await commerce.cart.remove("v1");
    await commerce.cart.applyCoupon("SAVE10");
    await commerce.cart.removeCoupon();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /api/v1/cart/items/v%201",
      "DELETE /api/v1/cart/items/v1",
      "POST /api/v1/cart/coupon",
      "DELETE /api/v1/cart/coupon",
    ]);
    expect(calls[0]!.body).toEqual({ quantity: 3 });
    expect(calls[2]!.body).toEqual({ code: "SAVE10" });
  });

  it("clear() removes every line and the coupon", async () => {
    let lines = ["a", "b"];
    let coupon: string | null = "X";
    const view = () => ({
      ...emptyCart("tok-clear-00001"),
      items: lines.map((v) => ({ variantId: v })),
      couponCode: coupon,
    });
    const { commerce, calls } = setup((c) => {
      if (c.method === "DELETE" && c.path.includes("/items/"))
        lines = lines.filter((l) => !c.path.endsWith(`/${l}`));
      if (c.method === "DELETE" && c.path.endsWith("/coupon")) coupon = null;
      return json(view());
    });
    const res = await commerce.cart.clear();
    expect(res.items).toHaveLength(0);
    expect(res.couponCode).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/cart",
      "DELETE /api/v1/cart/items/a",
      "DELETE /api/v1/cart/items/b",
      "DELETE /api/v1/cart/coupon",
    ]);
  });

  it("merge() sends the anonymous token in the body", async () => {
    const { commerce, calls } = setup(
      (c) => (c.path.endsWith("/merge") ? json(emptyCart("tok-customer-1")) : session()),
      { cartStorage: createMemoryCartStorage("tok-anon-123456") },
    );
    await commerce.auth.login({ email: "a@b.co", password: "pw" });
    await commerce.cart.merge();
    const merge = calls.find((c) => c.path.endsWith("/merge"))!;
    expect(merge.body).toEqual({ cartToken: "tok-anon-123456" });
    expect(merge.headers["x-csrf-token"]).toBe("csrf-1");
    expect(await commerce.cart.getToken()).toBe("tok-customer-1");
  });

  it("login({ mergeCart: true }) merges and a failed merge does not fail the login", async () => {
    const { commerce, calls } = setup(
      (c) => (c.path.endsWith("/merge") ? apiError(500, "INTERNAL_ERROR") : session()),
      { cartStorage: createMemoryCartStorage("tok-anon-123456") },
    );
    const s = await commerce.auth.login({ email: "a@b.co", password: "pw" }, { mergeCart: true });
    expect(s.customer.email).toBe("a@b.co");
    expect(calls.some((c) => c.path.endsWith("/merge"))).toBe(true);
    expect(await commerce.cart.getToken()).toBe("tok-anon-123456");
  });
});

describe("customer session, CSRF and refresh", () => {
  const route = (c: Call) => `${c.method} ${c.path.replace("/api/v1", "")}`;

  it("stores the csrf token from login and sends it on unsafe calls only", async () => {
    const { commerce, calls } = setup((c) => {
      if (route(c) === "POST /account/login") return session("csrf-A");
      if (route(c) === "PATCH /account/me") return json({ customer });
      return json({ items: [] });
    });
    await commerce.auth.login({ email: "a@b.co", password: "pw" });
    expect(commerce.auth.getCsrfToken()).toBe("csrf-A");
    await commerce.account.addresses.list();
    await commerce.account.update({ firstName: "Z" });
    const get = calls.find((c) => c.method === "GET")!;
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(get.headers["x-csrf-token"]).toBeUndefined();
    expect(patch.headers["x-csrf-token"]).toBe("csrf-A");
    expect(calls[0]!.init.credentials).toBe("include");
  });

  it("refreshes once on 401 and replays the original request with the new csrf", async () => {
    let first = true;
    const { commerce, calls } = setup((c) => {
      if (route(c) === "POST /account/login") return session("csrf-A");
      if (route(c) === "POST /account/refresh") return session("csrf-B");
      if (route(c) === "PATCH /account/me") {
        if (first) {
          first = false;
          return apiError(401, "UNAUTHENTICATED");
        }
        return json({ customer: { ...customer, firstName: "Z" } });
      }
      return json({});
    });
    await commerce.auth.login({ email: "a@b.co", password: "pw" });
    const updated = await commerce.account.update({ firstName: "Z" });
    expect(updated.firstName).toBe("Z");
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[0]!.headers["x-csrf-token"]).toBe("csrf-A");
    expect(patches[1]!.headers["x-csrf-token"]).toBe("csrf-B");
    expect(calls.filter((c) => route(c) === "POST /account/refresh")).toHaveLength(1);
  });

  it("does not loop: a second 401 after a successful refresh is surfaced", async () => {
    const onUnauthorized = vi.fn();
    const { commerce, calls } = setup(
      (c) =>
        route(c) === "POST /account/refresh" ? session("csrf-B") : apiError(401, "UNAUTHENTICATED"),
      { onUnauthorized },
    );
    await expect(commerce.account.orders.list()).rejects.toMatchObject({ status: 401 });
    expect(calls.filter((c) => route(c) === "GET /account/orders")).toHaveLength(2);
    expect(calls.filter((c) => route(c) === "POST /account/refresh")).toHaveLength(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("calls onUnauthorized and rethrows the original error when refresh fails", async () => {
    const onUnauthorized = vi.fn();
    const { commerce } = setup(() => apiError(401, "UNAUTHENTICATED", "Authentication required"), {
      onUnauthorized,
    });
    commerce.auth.setCsrfToken("old");
    const e = await commerce.account.orders.get("KC-1").catch((x) => x);
    expect(e.message).toBe("Authentication required");
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(commerce.auth.getCsrfToken()).toBeNull();
  });

  it("shares a single refresh between concurrent 401s", async () => {
    const seen = new Set<string>();
    const { commerce, calls } = setup((c) => {
      if (route(c) === "POST /account/refresh") return session("csrf-B");
      const key = route(c) + c.path;
      if (!seen.has(key)) {
        seen.add(key);
        return apiError(401, "UNAUTHENTICATED");
      }
      return json({ items: [] });
    });
    await Promise.all([commerce.account.addresses.list(), commerce.account.orders.list()]);
    expect(calls.filter((c) => route(c) === "POST /account/refresh")).toHaveLength(1);
  });

  it("login/register 401s do NOT trigger a refresh", async () => {
    const { commerce, calls } = setup(() =>
      apiError(401, "UNAUTHENTICATED", "Invalid email or password"),
    );
    await expect(commerce.auth.login({ email: "a@b.co", password: "bad" })).rejects.toMatchObject({
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });

  it("lazily loads the csrf token (after a page reload) before an unsafe account call", async () => {
    const { commerce, calls } = setup((c) => {
      if (route(c) === "GET /account/me") return session("csrf-lazy");
      return json({ customer });
    });
    await commerce.account.update({ firstName: "Q" });
    expect(calls.map(route)).toEqual(["GET /account/me", "PATCH /account/me"]);
    expect(calls[1]!.headers["x-csrf-token"]).toBe("csrf-lazy");
  });

  it("recovers from CSRF_FAILED by reloading the token once", async () => {
    let tries = 0;
    const { commerce, calls } = setup((c) => {
      if (route(c) === "GET /account/me") return session("csrf-new");
      if (route(c) === "POST /account/change-password") {
        return ++tries === 1 ? apiError(403, "CSRF_FAILED", "bad csrf") : json({ ok: true });
      }
      return json({});
    });
    commerce.auth.setCsrfToken("stale");
    await expect(
      commerce.account.changePassword({ currentPassword: "a", newPassword: "b" }),
    ).resolves.toEqual({ ok: true });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0]!.headers["x-csrf-token"]).toBe("stale");
    expect(posts[1]!.headers["x-csrf-token"]).toBe("csrf-new");
  });

  it("me() stores the csrf token", async () => {
    const { commerce } = setup(() => session("csrf-me"));
    const me = await commerce.auth.me();
    expect(me.customer.email).toBe("a@b.co");
    expect(commerce.auth.getCsrfToken()).toBe("csrf-me");
  });

  it("logout resolves and clears csrf when there is no session", async () => {
    const { commerce } = setup(() => apiError(401, "UNAUTHENTICATED"));
    commerce.auth.setCsrfToken("x");
    await expect(commerce.auth.logout()).resolves.toEqual({ ok: true });
    expect(commerce.auth.getCsrfToken()).toBeNull();
  });

  it("includes csrf on cart calls so a signed-in shopper is not treated as a guest", async () => {
    const { commerce, calls } = setup((c) =>
      route(c) === "POST /account/login" ? session("csrf-A") : json(emptyCart("tok-signedin-01")),
    );
    await commerce.auth.login({ email: "a@b.co", password: "pw" });
    await commerce.cart.add({ variantId: "v" });
    expect(calls[1]!.headers["x-csrf-token"]).toBe("csrf-A");
  });

  it("address CRUD hits the account endpoints", async () => {
    const { commerce, calls } = setup((c) =>
      c.method === "GET" ? json({ items: [{ id: "a1" }] }) : json({ id: "a1", ok: true }),
    );
    commerce.auth.setCsrfToken("t");
    expect(await commerce.account.addresses.list()).toEqual([{ id: "a1" }]);
    await commerce.account.addresses.create({
      fullName: "A",
      line1: "1",
      city: "c",
      postalCode: "1",
      country: "US",
    });
    await commerce.account.addresses.update("a1", { city: "d" });
    await commerce.account.addresses.remove("a1");
    expect(calls.map(route)).toEqual([
      "GET /account/addresses",
      "POST /account/addresses",
      "PATCH /account/addresses/a1",
      "DELETE /account/addresses/a1",
    ]);
  });

  it("forgot/reset password are anonymous POSTs", async () => {
    const { commerce, calls } = setup(() => json({ ok: true }));
    await commerce.auth.forgotPassword("a@b.co");
    await commerce.auth.resetPassword({ token: "t".repeat(24), newPassword: "NewPass123!" });
    expect(calls.map(route)).toEqual([
      "POST /account/forgot-password",
      "POST /account/reset-password",
    ]);
    expect(calls[0]!.body).toEqual({ email: "a@b.co" });
  });
});
