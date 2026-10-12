import { describe, expect, it } from "vitest";
import {
  createCommerceClient,
  formatMoney,
  fromMinorUnits,
  parseProductQuery,
  productQueryParams,
  serializeJsonLd,
  toMinorUnits,
  toSearchParams,
} from "../src";
import { json, setup } from "./helpers";

describe("request building", () => {
  it("appends /api/v1 to the base URL and strips trailing slashes", async () => {
    const { commerce, calls } = setup(() => json({ name: "S" }), { baseUrl: "http://api.test///" });
    await commerce.store.getSettings();
    expect(calls[0]!.url).toBe("http://api.test/api/v1/store/settings");
    expect(commerce.apiBase).toBe("http://api.test/api/v1");
  });

  it("does not double the /api/v1 prefix and supports same-origin (empty) base", async () => {
    const a = setup(() => json({}), { baseUrl: "http://api.test/api/v1" });
    await a.commerce.store.getSettings();
    expect(a.calls[0]!.url).toBe("http://api.test/api/v1/store/settings");
    const b = setup(() => json({}), { baseUrl: "" });
    await b.commerce.store.getSettings();
    expect(b.calls[0]!.url).toBe("/api/v1/store/settings");
  });

  it("sends Accept, credentials include by default and no body/content-type on GET", async () => {
    const { commerce, calls } = setup(() => json({}));
    await commerce.store.getSettings();
    const c = calls[0]!;
    expect(c.method).toBe("GET");
    expect(c.headers.accept).toBe("application/json");
    expect(c.headers["content-type"]).toBeUndefined();
    expect(c.init.credentials).toBe("include");
    expect(c.init.body).toBeUndefined();
  });

  it("honours a custom credentials mode", async () => {
    const { commerce, calls } = setup(() => json({}), { credentials: "same-origin" });
    await commerce.store.getSettings();
    expect(calls[0]!.init.credentials).toBe("same-origin");
  });

  it("sends JSON bodies with a content-type on POST", async () => {
    const { commerce, calls } = setup(() => json({ id: "r" }, 201));
    await commerce.reviews.create("tee", {
      rating: 5,
      body: "great",
      authorName: "A",
      email: "a@b.co",
    });
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.path).toBe("/api/v1/products/tee/reviews");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.body).toEqual({ rating: 5, body: "great", authorName: "A", email: "a@b.co" });
  });

  it("merges static and dynamic custom headers", async () => {
    let n = 0;
    const { commerce, calls } = setup(() => json({}), {
      headers: () => ({ "x-trace": `t${++n}`, cookie: "kc_customer=abc" }),
    });
    await commerce.store.getSettings();
    await commerce.store.getSettings();
    expect(calls[0]!.headers["x-trace"]).toBe("t1");
    expect(calls[1]!.headers["x-trace"]).toBe("t2");
    expect(calls[0]!.headers.cookie).toBe("kc_customer=abc");
  });

  it("url-encodes path segments", async () => {
    const { commerce, calls } = setup(() => json({}));
    await commerce.products.getBySlug("a/b c");
    expect(calls[0]!.url).toContain("/products/a%2Fb%20c");
  });

  it("throws when no fetch is available and none injected", async () => {
    const orig = globalThis.fetch;
    // @ts-expect-error simulate an old runtime
    globalThis.fetch = undefined;
    try {
      const c = createCommerceClient({ baseUrl: "http://x", retry: false });
      await expect(c.store.getSettings()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("query serialisation", () => {
  it("expands attributes and properties into attr.* / prop.* comma lists", async () => {
    const { commerce, calls } = setup(() => json({ items: [] }));
    await commerce.products.list({
      page: 2,
      pageSize: 12,
      category: "shirts",
      collection: "summer",
      tag: ["sale", "new"],
      minPrice: 10,
      maxPrice: "99.50",
      inStock: true,
      sort: "price_asc",
      attributes: { color: ["red", "blue"], size: ["m"] },
      properties: { fit: ["slim"], material: "cotton" },
    });
    const s = calls[0]!.search;
    expect(calls[0]!.path).toBe("/api/v1/products");
    expect(s.get("page")).toBe("2");
    expect(s.get("pageSize")).toBe("12");
    expect(s.get("category")).toBe("shirts");
    expect(s.get("tag")).toBe("sale,new");
    expect(s.get("minPrice")).toBe("10");
    expect(s.get("maxPrice")).toBe("99.50");
    expect(s.get("inStock")).toBe("true");
    expect(s.get("sort")).toBe("price_asc");
    expect(s.get("attr.color")).toBe("red,blue");
    expect(s.get("attr.size")).toBe("m");
    expect(s.get("prop.fit")).toBe("slim");
    expect(s.get("prop.material")).toBe("cotton");
  });

  it("drops undefined, null, empty and false values", () => {
    const qs = toSearchParams({ a: undefined, b: null, c: "", d: [], e: false, f: 0, g: ["x"] });
    expect(qs).toBe("e=false&f=0&g=x");
    expect(productQueryParams({ inStock: false, attributes: { color: [] } })).not.toHaveProperty(
      "inStock",
    );
    expect(toSearchParams(productQueryParams({ attributes: { color: [] } }))).toBe("");
  });

  it("produces stable, sorted output", () => {
    expect(toSearchParams({ z: 1, a: 2 })).toBe("a=2&z=1");
  });

  it("search() sends q on /products/search", async () => {
    const { commerce, calls } = setup(() => json({ items: [] }));
    await commerce.products.search("blue shirt", { pageSize: 5 });
    expect(calls[0]!.path).toBe("/api/v1/products/search");
    expect(calls[0]!.search.get("q")).toBe("blue shirt");
    expect(calls[0]!.search.get("pageSize")).toBe("5");
  });

  it("parseProductQuery is the inverse of productQueryParams", () => {
    const q = parseProductQuery("page=3&category=x&attr.color=red,blue&prop.fit=slim&inStock=true");
    expect(q).toEqual({
      page: 3,
      category: "x",
      attributes: { color: ["red", "blue"] },
      properties: { fit: ["slim"] },
      inStock: true,
    });
  });

  it("filters.get merges category, selections and device", async () => {
    const { commerce, calls } = setup(() => json({ category: null, groups: [] }));
    await commerce.filters.get({
      category: "shirts",
      selections: { attributes: { color: ["red"] }, minPrice: "5" },
      device: "mobile",
    });
    const s = calls[0]!.search;
    expect(calls[0]!.path).toBe("/api/v1/filters");
    expect(s.get("category")).toBe("shirts");
    expect(s.get("attr.color")).toBe("red");
    expect(s.get("minPrice")).toBe("5");
    expect(s.get("device")).toBe("mobile");
  });

  it("navigation.get defaults to the header menu; categories.list unwraps items", async () => {
    const { commerce, calls } = setup((c) =>
      c.path.endsWith("/categories") ? json({ items: [{ id: "1" }] }) : json({ items: [] }),
    );
    await commerce.navigation.get();
    expect(calls[0]!.search.get("menu")).toBe("header");
    const cats = await commerce.categories.list({ counts: true });
    expect(cats).toEqual([{ id: "1" }]);
    expect(calls[1]!.search.get("counts")).toBe("true");
  });

  it("orders helpers pass the email and build an invoice URL", async () => {
    const { commerce, calls } = setup(() => json({ orderNumber: "KC-1" }));
    await commerce.orders.get("KC-100001", "a@b.co");
    expect(calls[0]!.path).toBe("/api/v1/orders/KC-100001");
    expect(calls[0]!.search.get("email")).toBe("a@b.co");
    expect(commerce.orders.invoiceUrl("KC-100001", "a@b.co")).toBe(
      "http://api.test/api/v1/orders/KC-100001/invoice.pdf?email=a%40b.co",
    );
  });

  it("payments and returns use the contracted endpoints", async () => {
    const { commerce, calls } = setup(() => json({}));
    await commerce.payments.verify({
      orderNumber: "KC-1",
      providerOrderId: "o",
      providerPaymentId: "p",
      signature: "s",
    });
    await commerce.payments.retry({ orderNumber: "KC-1", email: "a@b.co" });
    await commerce.returns.create({
      orderNumber: "KC-1",
      email: "a@b.co",
      reason: "SIZE",
      items: [{ orderItemId: "i", quantity: 1 }],
    });
    await commerce.returns.get("r1", "a@b.co");
    await commerce.orders.tracking("KC-1", "a@b.co");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/payments/verify",
      "POST /api/v1/payments/retry",
      "POST /api/v1/returns",
      "GET /api/v1/returns/r1",
      "GET /api/v1/orders/KC-1/tracking",
    ]);
  });
});

describe("helpers", () => {
  it("formatMoney formats strings and degrades gracefully", () => {
    expect(formatMoney("1299.5", "USD", "en-US")).toBe("$1,299.50");
    expect(formatMoney("1299.50", "INR", "en-IN")).toContain("1,299.50");
    expect(formatMoney(null, "USD")).toBe("");
    expect(formatMoney("abc", "USD")).toBe("abc");
    expect(formatMoney("5", "NOPE!")).toBe("NOPE! 5.00");
  });

  it("minor unit conversion is exact", () => {
    expect(toMinorUnits("19.99")).toBe(1999);
    expect(toMinorUnits("5")).toBe(500);
    expect(toMinorUnits("0.5")).toBe(50);
    expect(fromMinorUnits(1999)).toBe("19.99");
    expect(fromMinorUnits(5)).toBe("0.05");
    expect(() => toMinorUnits("1.234")).toThrow();
  });

  it("serializeJsonLd cannot break out of a script tag", () => {
    const out = serializeJsonLd({ name: "</script><script>alert(1)</script>&" });
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>&");
  });
});
