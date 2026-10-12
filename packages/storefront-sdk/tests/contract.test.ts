/**
 * CONTRACT TEST - runs the SDK against a REAL running Commerce API.
 *
 * Skipped unless COMMERCE_API_URL is set:
 *   COMMERCE_API_URL=http://localhost:4100 npm test -w @kash-commerce/storefront-sdk
 *
 * The API needs a few published products with stock (see examples/demo-storefront/scripts/seed.mjs).
 * It uses the MANUAL payment provider for checkout, a unique customer email per run, and a tiny
 * cookie jar so the customer session cookie works from Node (browsers do this natively).
 * NODE_ENV=test on the API disables rate limits; in development the limits are generous enough.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CommerceError,
  createCommerceClient,
  createMemoryCartStorage,
  type CommerceClient,
  type ProductDetail,
  type ProductVariant,
} from "../src";

const API_URL = process.env.COMMERCE_API_URL;

/** Minimal cookie jar around fetch (Node has none). */
function cookieJarFetch(): typeof globalThis.fetch {
  const jar = new Map<string, string>();
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(input, { ...init, headers });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair = ""] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }) as typeof globalThis.fetch;
}

const newClient = (): CommerceClient =>
  createCommerceClient({
    baseUrl: API_URL!,
    fetch: cookieJarFetch(),
    cartStorage: createMemoryCartStorage(),
    timeoutMs: 20000,
  });

const stamp = Date.now().toString(36);
const address = {
  fullName: "Contract Tester",
  phone: "5551234567",
  line1: "1 Test Street",
  city: "Testville",
  state: "CA",
  postalCode: "94000",
  country: "US",
};

describe.skipIf(!API_URL)("SDK <-> real API contract", () => {
  let commerce: CommerceClient;
  let product: ProductDetail | undefined;
  let variant: ProductVariant | undefined;

  beforeAll(async () => {
    commerce = newClient();
    const list = await commerce.products.list({ pageSize: 50, inStock: true });
    for (const item of list.items) {
      const detail = await commerce.products.getBySlug(item.slug);
      const v = detail.variants.find((x) => x.inStock && x.available >= 2);
      if (v) {
        product = detail;
        variant = v;
        break;
      }
    }
  });

  it("store settings", async () => {
    const s = await commerce.store.getSettings();
    expect(typeof s.name).toBe("string");
    expect(s.currency).toMatch(/^[A-Z]{3}$/);
    expect(s.features).toHaveProperty("guestCheckout");
  });

  it("lists products with pagination and money as strings", async () => {
    const page = await commerce.products.list({ pageSize: 2, sort: "price_asc" });
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(2);
    expect(page.items.length).toBeLessThanOrEqual(2);
    for (const p of page.items) if (p.price !== null) expect(p.price).toMatch(/^\d+\.\d{2}$/);
    const seen = new Set<string>();
    for await (const p of commerce.products.listAll({ pageSize: 2 }, { maxPages: 3 })) {
      expect(seen.has(p.id)).toBe(false);
      seen.add(p.id);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("gets a product by slug, searches and filters by attribute", async () => {
    expect(product).toBeDefined();
    expect(variant!.price).toMatch(/^\d+\.\d{2}$/);
    const found = await commerce.products.search(product!.title.split(" ")[0]!);
    expect(found.items.some((p) => p.slug === product!.slug)).toBe(true);
    const opt = product!.options[0];
    if (opt) {
      const filtered = await commerce.products.list({
        attributes: { [opt.attributeSlug]: [opt.values[0]!.slug] },
      });
      expect(filtered.items.length).toBeGreaterThan(0);
    }
  });

  it("maps 404s to CommerceError.isNotFound()", async () => {
    const e = await commerce.products.getBySlug("definitely-not-a-product").catch((x) => x);
    expect(e).toBeInstanceOf(CommerceError);
    expect(e.isNotFound()).toBe(true);
    expect(e.code).toBe("NOT_FOUND");
    expect(e.requestId).toBeTruthy();
  });

  it("categories, navigation, filters, pages", async () => {
    const cats = await commerce.categories.list({ counts: true });
    expect(Array.isArray(cats)).toBe(true);
    if (cats[0]) {
      const detail = await commerce.categories.get(cats[0].slug);
      expect(detail.slug).toBe(cats[0].slug);
      const f = await commerce.filters.get({ category: cats[0].slug, device: "desktop" });
      expect(f.category?.slug).toBe(cats[0].slug);
    }
    const nav = await commerce.navigation.get();
    expect(nav.key).toBe("header");
    expect(Array.isArray(nav.items)).toBe(true);
    const all = await commerce.filters.get();
    expect(Array.isArray(all.groups)).toBe(true);
    const pages = await commerce.pages.list();
    expect(Array.isArray(pages)).toBe(true);
    if (pages.some((p) => p.slug === "home")) {
      const home = await commerce.pages.get("home");
      expect(home.sections.length).toBeGreaterThan(0);
      expect(typeof home.sections[0]!.type).toBe("string");
    }
    expect(await commerce.collections.list()).toBeInstanceOf(Array);
  });

  it("cart lifecycle with automatic token handling", async () => {
    expect(variant).toBeDefined();
    const c = newClient();
    expect((await c.cart.get()).items).toEqual([]);
    expect(await c.cart.getToken()).toBeNull();
    const added = await c.cart.add({ variantId: variant!.id, quantity: 1 });
    expect(added.token).toBeTruthy();
    expect(await c.cart.getToken()).toBe(added.token);
    expect(added.itemCount).toBe(1);
    const updated = await c.cart.update(variant!.id, 2);
    expect(updated.itemCount).toBe(2);
    expect(updated.items[0]!.unitPrice).toBe(variant!.price);
    const bad = await c.cart.applyCoupon("NOPE-NOT-A-COUPON").catch((x) => x);
    expect(bad).toBeInstanceOf(CommerceError);
    expect(bad.isValidation()).toBe(true);
    const over = await c.cart.update(variant!.id, 99).catch((x) => x);
    expect(over.isOutOfStock()).toBe(true);
    const cleared = await c.cart.clear();
    expect(cleared.items).toEqual([]);
    expect(cleared.itemCount).toBe(0);
  });

  it("guest checkout (MANUAL) with idempotency, then order lookup", async () => {
    expect(variant).toBeDefined();
    const c = newClient();
    await c.cart.add({ variantId: variant!.id, quantity: 1 });
    const methods = await c.checkout.shippingMethods({ country: "US", subtotal: variant!.price });
    expect(Array.isArray(methods)).toBe(true);
    const summary = await c.checkout.summary({
      shippingAddress: address,
      shippingMethodCode: methods[0]?.code,
    });
    expect(summary.lines).toHaveLength(1);
    expect(summary.total).toMatch(/^\d+\.\d{2}$/);

    const input = {
      email: `guest+${stamp}@example.com`,
      shippingAddress: address,
      shippingMethodCode: methods[0]?.code,
      paymentProvider: "MANUAL",
    };
    const result = await c.checkout.create(input, { idempotencyKey: `contract-${stamp}-1` });
    expect(result.order.orderNumber).toBeTruthy();
    expect(result.paymentRequired).toBe(false);
    expect(result.order.status).toBe("CONFIRMED");
    expect(result.order.total).toBe(summary.total);

    const replay = await c.checkout.create(input, { idempotencyKey: `contract-${stamp}-1` });
    expect(replay.order.orderNumber).toBe(result.order.orderNumber);
    expect(replay.idempotentReplay).toBe(true);

    const fetched = await c.orders.get(result.order.orderNumber, input.email);
    expect(fetched.orderNumber).toBe(result.order.orderNumber);
    const wrongEmail = await c.orders
      .get(result.order.orderNumber, "other@example.com")
      .catch((e) => e);
    expect(wrongEmail.isNotFound()).toBe(true);
    expect(c.orders.invoiceUrl(result.order.orderNumber, input.email)).toContain(
      "/invoice.pdf?email=",
    );
    expect((await c.cart.get()).items).toEqual([]);
  });

  it("customer account: register, session cookie + csrf, addresses, refresh, logout", async () => {
    const c = newClient();
    const email = `customer+${stamp}@example.com`;
    const password = "Contract-Test-Pass-123!";
    const s = await c.auth.register({ email, password, firstName: "Contract" });
    expect(s.customer.email).toBe(email);
    expect(s.csrfToken).toBeTruthy();
    expect(c.auth.getCsrfToken()).toBe(s.csrfToken);

    expect((await c.auth.me()).customer.id).toBe(s.customer.id);
    const updated = await c.account.update({ lastName: "Tester" });
    expect(updated.lastName).toBe("Tester");

    const created = await c.account.addresses.create({ ...address, label: "Home" });
    expect(created.isDefaultShipping).toBe(true);
    expect((await c.account.addresses.list()).map((a) => a.id)).toContain(created.id);
    await c.account.addresses.remove(created.id);

    const refreshed = await c.auth.refresh();
    expect(refreshed.csrfToken).not.toBe(s.csrfToken);
    await c.account.update({ firstName: "Again" }); // works with the rotated csrf token

    const orders = await c.account.orders.list();
    expect(orders.page).toBe(1);

    await c.auth.logout();
    const after = await c.auth.me().catch((e) => e);
    expect(after).toBeInstanceOf(CommerceError);
    expect(after.status).toBe(401);

    const login = await c.auth.login({ email, password });
    expect(login.customer.email).toBe(email);
    const bad = await newClient()
      .auth.login({ email, password: "wrong-password" })
      .catch((e) => e);
    expect(bad.status).toBe(401);
  });

  it("session refresh-once: an expired CSRF/session recovers transparently", async () => {
    const c = newClient();
    const email = `refresh+${stamp}@example.com`;
    await c.auth.register({ email, password: "Contract-Test-Pass-123!" });
    c.auth.setCsrfToken("stale-token-from-a-previous-page"); // simulates a reloaded SPA with stale state
    const p = await c.account.update({ firstName: "Recovered" });
    expect(p.firstName).toBe("Recovered");
  });

  it("reviews are moderated (PENDING) and duplicate reviews conflict", async () => {
    expect(product).toBeDefined();
    const email = `reviewer+${stamp}@example.com`;
    const input = { rating: 5, title: "Great", body: "Loved it", authorName: "Rev Iewer", email };
    const r = await commerce.reviews.create(product!.slug, input);
    expect(r.status).toBe("PENDING");
    const dup = await commerce.reviews.create(product!.slug, input).catch((e) => e);
    expect(dup.code).toBe("CONFLICT");
    const list = await commerce.reviews.list(product!.slug, { pageSize: 5 });
    expect(list.aggregate).toHaveProperty("distribution");
    const invalid = await commerce.reviews
      .create(product!.slug, { ...input, rating: 9, email: "x@y.co" })
      .catch((e) => e);
    expect(invalid.isValidation()).toBe(true);
    expect(invalid.fieldErrors().length).toBeGreaterThan(0);
  });

  it("blog and SEO", async () => {
    const posts = await commerce.blog.list({ pageSize: 5 });
    expect(Array.isArray(posts.items)).toBe(true);
    if (posts.items[0]) {
      const post = await commerce.blog.getBySlug(posts.items[0].slug);
      expect(post.body).toBeDefined();
    }
    const sitemap = await commerce.seo.sitemap();
    expect(Array.isArray(sitemap.products)).toBe(true);
    expect((await commerce.seo.robots()).sitemapPath).toBeTruthy();
    expect(await commerce.seo.defaults()).toHaveProperty("titleTemplate");
    expect((await commerce.seo.jsonLd("organization"))["@type"]).toBe("Organization");
    const ld = await commerce.seo.jsonLd("product", product!.slug);
    expect(ld["@type"]).toBe("Product");
    expect(ld["@context"]).toBe("https://schema.org");
  });
});
