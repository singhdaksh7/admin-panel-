#!/usr/bin/env node
/**
 * Seeds a local Commerce API with demo catalogue data so the demo storefront has something to show.
 * DEV ONLY - it talks to the ADMIN API with admin credentials. It is NOT part of the storefront SDK.
 *
 *   COMMERCE_API_URL=http://localhost:4000 \
 *   COMMERCE_ADMIN_EMAIL=admin@example.com COMMERCE_ADMIN_PASSWORD=... \
 *   node scripts/seed.mjs
 *
 * Safe to re-run: existing slugs are left in place (409/422 conflicts are reported and skipped).
 */
const API =
  (process.env.COMMERCE_API_URL ?? "http://localhost:4000").replace(/\/+$/, "") + "/api/v1";
const EMAIL = process.env.COMMERCE_ADMIN_EMAIL;
const PASSWORD = process.env.COMMERCE_ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Set COMMERCE_ADMIN_EMAIL and COMMERCE_ADMIN_PASSWORD");
  process.exit(1);
}

let cookie = "";
let csrf = "";

async function call(method, path, body, { allow = [] } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok && !allow.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data?.error ?? data)}`);
  }
  return { status: res.status, data };
}

const log = (...a) => console.log("  ", ...a);

async function main() {
  const login = await call("POST", "/admin/auth/login", { email: EMAIL, password: PASSWORD });
  csrf = login.data.csrfToken;
  console.log("Logged in as", login.data.user.email);

  await call("PUT", "/admin/settings", {
    name: "Kash Demo Store",
    currency: "USD",
    locale: "en-US",
    supportEmail: "support@demo.test",
    features: { reviews: true, blog: true, guestCheckout: true, customerAccounts: true },
  });
  log("settings updated");

  // categories
  const cat = async (name, parentId) => {
    const r = await call(
      "POST",
      "/admin/categories",
      { name, parentId: parentId ?? null },
      { allow: [409] },
    );
    if (r.status === 201) return r.data.id;
    const all = await call("GET", "/admin/categories");
    const flat = [];
    const walk = (n) => (n ?? []).forEach((c) => (flat.push(c), walk(c.children)));
    walk(all.data.items ?? all.data);
    return flat.find((c) => c.name === name)?.id;
  };
  const apparel = await cat("Apparel");
  const tees = await cat("T-Shirts", apparel);
  const hoodies = await cat("Hoodies", apparel);
  const accessories = await cat("Accessories");
  log("categories ready");

  // attributes
  const attr = async (name, values, extra = {}) => {
    await call(
      "POST",
      "/admin/attributes",
      {
        name,
        usedForVariants: true,
        isFilterable: true,
        values: values.map((value) => ({ value })),
        ...extra,
      },
      { allow: [409, 422] },
    );
    const all = await call("GET", "/admin/attributes");
    const a = all.data.items.find((x) => x.name === name);
    return { id: a.id, values: Object.fromEntries(a.values.map((v) => [v.value, v.id])) };
  };
  const color = await attr("Color", ["Black", "White", "Navy"]);
  const size = await attr("Size", ["S", "M", "L"]);
  log("attributes ready");

  // products
  const product = async (body) => {
    const r = await call("POST", "/admin/products", body, { allow: [409, 422] });
    log(r.status === 201 ? "product created" : `product ${body.title}: skipped (${r.status})`);
  };
  const variantsFor = (skuBase, price, colors, sizes) =>
    colors.flatMap((c) =>
      sizes.map((s) => ({
        sku: `${skuBase}-${c[0]}-${s}`.toUpperCase(),
        title: `${c} / ${s}`,
        price,
        stock: s === "L" && c === "White" ? 0 : 25,
        attributeValueIds: [color.values[c], size.values[s]],
      })),
    );
  await product({
    title: "Classic Tee",
    slug: "classic-tee",
    status: "ACTIVE",
    categoryId: tees,
    brand: "Kash",
    isFeatured: true,
    isNew: true,
    shortDescription: "Heavyweight organic cotton tee.",
    description: "A soft, heavyweight tee that gets better with every wash.",
    tags: ["bestseller"],
    properties: { fit: "Regular" },
    variants: variantsFor("TEE", "24.00", ["Black", "White", "Navy"], ["S", "M", "L"]),
  });
  await product({
    title: "Boxy Tee",
    slug: "boxy-tee",
    status: "ACTIVE",
    categoryId: tees,
    brand: "Kash",
    shortDescription: "Oversized boxy fit.",
    tags: ["new"],
    properties: { fit: "Oversized" },
    variants: variantsFor("BOX", "29.00", ["Black", "White"], ["M", "L"]).map((v, i) => ({
      ...v,
      compareAtPrice: i === 0 ? "39.00" : undefined,
    })),
  });
  await product({
    title: "Everyday Hoodie",
    slug: "everyday-hoodie",
    status: "ACTIVE",
    categoryId: hoodies,
    brand: "Kash",
    isFeatured: true,
    shortDescription: "Brushed fleece, kangaroo pocket.",
    properties: { fit: "Regular" },
    variants: variantsFor("HOOD", "64.00", ["Black", "Navy"], ["S", "M", "L"]),
  });
  await product({
    title: "Canvas Tote",
    slug: "canvas-tote",
    status: "ACTIVE",
    categoryId: accessories,
    brand: "Kash",
    shortDescription: "Carries everything.",
    price: "18.00",
    sku: "TOTE-1",
    stock: 40,
  });
  await product({
    title: "Dad Cap",
    slug: "dad-cap",
    status: "ACTIVE",
    categoryId: accessories,
    brand: "Kash",
    shortDescription: "Unstructured six panel cap.",
    price: "22.00",
    sku: "CAP-1",
    stock: 0,
  });

  // shipping
  await call(
    "POST",
    "/admin/shipping-methods",
    {
      code: "standard",
      name: "Standard (3-5 days)",
      type: "FLAT",
      price: "5.00",
      minDays: 3,
      maxDays: 5,
    },
    { allow: [409, 422] },
  );
  await call(
    "POST",
    "/admin/shipping-methods",
    {
      code: "free",
      name: "Free over $75",
      type: "FREE_OVER",
      price: "9.00",
      freeOverAmount: "75.00",
    },
    { allow: [409, 422] },
  );
  log("shipping methods ready");

  // filters (global)
  await call("PUT", "/admin/filters/scope/global", {
    groups: [
      { source: "CATEGORY", label: "Category", multiSelect: false },
      { source: "PRICE", label: "Price" },
      { source: "ATTRIBUTE", attributeId: color.id, label: "Color" },
      { source: "ATTRIBUTE", attributeId: size.id, label: "Size", defaultOpen: false },
      { source: "PROPERTY", propertyKey: "fit", label: "Fit", defaultOpen: false },
      { source: "STOCK", label: "In stock only" },
    ],
  });
  log("filters configured");

  // navigation
  await call("PUT", "/admin/navigation/header", {
    items: [
      {
        label: "Shop",
        type: "LINK",
        url: "/products",
        children: [
          { label: "Apparel", type: "CATEGORY", categorySlug: "apparel", autoChildren: true },
          { label: "Accessories", type: "CATEGORY", categorySlug: "accessories" },
        ],
      },
      { label: "Journal", type: "LINK", url: "/blog" },
      { label: "About", type: "PAGE", pageSlug: "about" },
    ],
  });
  await call("PUT", "/admin/navigation/footer", {
    items: [{ label: "About", type: "PAGE", pageSlug: "about" }],
  });
  log("navigation ready");

  // blog
  await call(
    "POST",
    "/admin/blog",
    {
      title: "Welcome to the journal",
      slug: "welcome",
      status: "PUBLISHED",
      excerpt: "Why we built this store.",
      body: "<p>We make simple, durable basics.</p>",
      authorName: "The Kash team",
      tags: ["news"],
    },
    { allow: [409, 422] },
  );
  log("blog ready");

  // pages
  const page = async (slug, title, sections) => {
    const r = await call(
      "POST",
      "/admin/pages",
      { slug, title, status: "PUBLISHED" },
      { allow: [409] },
    );
    if (r.status !== 201) return log(`page ${slug} exists, left unchanged`);
    for (const s of sections) await call("POST", `/admin/pages/${r.data.id}/sections`, s);
    log(`page ${slug} created`);
  };
  await page("home", "Home", [
    {
      type: "HERO",
      content: {
        heading: "Basics, done properly",
        subheading: "Heavyweight cotton, honest prices.",
        cta: { label: "Shop all", url: "/products" },
        align: "left",
      },
    },
    { type: "CATEGORY_GRID", content: { heading: "Shop by category", limit: 4 } },
    {
      type: "PRODUCT_GRID",
      content: { heading: "Featured", featuredOnly: true, limit: 4, sort: "featured" },
    },
    {
      type: "PROMO_BANNER",
      content: {
        text: "Free shipping on orders over $75",
        cta: { label: "Start shopping", url: "/products" },
        backgroundColor: "#1f3a2e",
        textColor: "#ffffff",
      },
    },
    { type: "BLOG_PREVIEW", content: { heading: "From the journal", limit: 3 } },
  ]);
  await page("about", "About us", [
    {
      type: "RICH_TEXT",
      content: { html: "<h1>About us</h1><p>We are a small team making simple basics.</p>" },
    },
  ]);

  console.log("Seed complete.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
