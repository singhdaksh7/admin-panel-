import { beforeAll, describe, expect, it } from "vitest";
import {
  bootApp,
  createAdminWithRole,
  loginAdmin,
  prisma,
  request,
  type AdminSessionHandle,
} from "./helpers";
import { mkCategory, mkMedia, mkProduct } from "./contentFixtures";
import { resolveSeo } from "../src/modules/seo";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: AdminSessionHandle;

beforeAll(async () => {
  const b = await bootApp();
  app = b.app;
  admin = await b.admin();
});

describe("resolveSeo", () => {
  const defaults = {
    titleTemplate: "%s | Shop",
    defaultTitle: "Shop",
    defaultDescription: "Default desc",
    defaultOgImageMediaId: "og1",
    robots: "index" as const,
  };
  it("merges entity seo over defaults", () => {
    expect(
      resolveSeo(
        {
          title: "Tee",
          description: "d",
          canonicalUrl: "https://x.example/t",
          ogImageMediaId: "og2",
          nofollow: true,
        },
        defaults,
      ),
    ).toMatchObject({
      title: "Tee | Shop",
      description: "d",
      canonicalUrl: "https://x.example/t",
      ogImageMediaId: "og2",
      noindex: false,
      nofollow: true,
      robots: "index,nofollow",
    });
  });
  it("falls back to defaults and to the entity fallback title", () => {
    expect(resolveSeo(null, defaults)).toMatchObject({
      title: "Shop | Shop",
      description: "Default desc",
      ogImageMediaId: "og1",
    });
    expect(resolveSeo({}, defaults, { title: "Prod", description: "from product" })).toMatchObject({
      title: "Prod | Shop",
      description: "from product",
    });
    expect(resolveSeo(undefined, undefined)).toMatchObject({
      title: "",
      noindex: false,
      canonicalUrl: null,
    });
  });
  it("store-wide noindex wins over the entity", () => {
    expect(resolveSeo({ noindex: false }, { ...defaults, robots: "noindex" })).toMatchObject({
      noindex: true,
      nofollow: true,
    });
    expect(resolveSeo({ noindex: true }, defaults).noindex).toBe(true);
  });
});

describe("seo defaults admin", () => {
  it("reads/updates defaults persisted in IntegrationSetting", async () => {
    const media = await mkMedia("og.jpg");
    const before = await admin.get("/api/v1/admin/seo");
    expect(before.body).toMatchObject({ titleTemplate: "%s", robots: "index" });
    const up = await admin.put("/api/v1/admin/seo", {
      titleTemplate: "%s - Store",
      defaultDescription: "Hi",
      defaultOgImageMediaId: media.id,
      siteUrl: "https://shop.example.com",
    });
    expect(up.status).toBe(200);
    expect((await admin.get("/api/v1/admin/seo")).body.titleTemplate).toBe("%s - Store");
    const row = await prisma.integrationSetting.findUniqueOrThrow({
      where: { kind_provider: { kind: "SEO", provider: "DEFAULTS" } },
    });
    expect(row.config).toMatchObject({ defaultDescription: "Hi" });
    const pub = await request(app).get("/api/v1/seo/defaults");
    expect(pub.body.defaultOgImageUrl).toBe("og.jpg");
    expect((await admin.put("/api/v1/admin/seo", { titleTemplate: "no placeholder" })).status).toBe(
      422,
    );
    expect((await admin.put("/api/v1/admin/seo", { defaultOgImageMediaId: "nope" })).status).toBe(
      422,
    );
    expect((await admin.put("/api/v1/admin/seo", { bogus: 1 })).status).toBe(422);
  });

  it("only seo.write can access it", async () => {
    await createAdminWithRole("CONTENT_MANAGER", "cm@x.example");
    await createAdminWithRole("CATALOG_MANAGER", "cat@x.example");
    await createAdminWithRole("SUPPORT", "sup@x.example");
    const cm = await loginAdmin(app, "cm@x.example", "Another-Pass-123");
    const cat = await loginAdmin(app, "cat@x.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup@x.example", "Another-Pass-123");
    expect((await cm.put("/api/v1/admin/seo", { robots: "index" })).status).toBe(200);
    expect((await cat.put("/api/v1/admin/seo", { robots: "index" })).status).toBe(403);
    expect((await sup.get("/api/v1/admin/seo")).status).toBe(403);
  });
});

describe("sitemap and robots", () => {
  it("lists only published, indexable entities", async () => {
    const cat = await mkCategory("Live Cat");
    await mkCategory("Dead Cat", null, { isActive: false });
    await mkProduct({ slug: "pub", categoryId: cat.id });
    await mkProduct({ slug: "drft", status: "DRAFT" });
    await mkProduct({ slug: "arch", status: "ARCHIVED" });
    await mkProduct({ slug: "later", publishAt: new Date(Date.now() + 1e8) });
    await prisma.collection.create({ data: { name: "On", slug: "on" } });
    await prisma.collection.create({ data: { name: "Off", slug: "off", isActive: false } });
    await prisma.page.create({ data: { slug: "about", title: "A", status: "PUBLISHED" } });
    await prisma.page.create({ data: { slug: "secret", title: "S", status: "DRAFT" } });
    await prisma.page.create({
      data: { slug: "hidden", title: "H", status: "PUBLISHED", seo: { noindex: true } },
    });
    await prisma.blogPost.create({
      data: { slug: "b-pub", title: "x", body: "", status: "PUBLISHED" },
    });
    await prisma.blogPost.create({
      data: { slug: "b-draft", title: "x", body: "", status: "DRAFT" },
    });
    await prisma.blogPost.create({
      data: {
        slug: "b-future",
        title: "x",
        body: "",
        status: "PUBLISHED",
        publishAt: new Date(Date.now() + 1e8),
      },
    });

    const r = await request(app).get("/api/v1/seo/sitemap");
    expect(r.status).toBe(200);
    const slugs = (k: string) => r.body[k].map((x: { slug: string }) => x.slug);
    expect(slugs("products")).toEqual(["pub"]);
    expect(slugs("categories")).toEqual(["live-cat"]);
    expect(slugs("collections")).toEqual(["on"]);
    expect(slugs("pages")).toEqual(["about"]);
    expect(slugs("blog")).toEqual(["b-pub"]);
    expect(r.body.products[0].updatedAt).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(
      /drft|arch|later|dead-cat|off|secret|hidden|b-draft|b-future/,
    );
  });

  it("robots reflects the store-wide robots default", async () => {
    let r = await request(app).get("/api/v1/seo/robots");
    expect(r.body.allow).toBe(true);
    expect(r.body.disallow).toContain("/checkout");
    await admin.put("/api/v1/admin/seo", { robots: "noindex" });
    r = await request(app).get("/api/v1/seo/robots");
    expect(r.body).toMatchObject({ allow: false, disallow: ["/"] });
    await admin.put("/api/v1/admin/seo", { robots: "index" });
  });
});

describe("json-ld", () => {
  it("Product with offers and aggregateRating from approved reviews only", async () => {
    const p = await mkProduct({ slug: "ld", price: "19.90", onHand: 0, title: "LD Tee" });
    await prisma.product.update({ where: { id: p.id }, data: { brand: "Acme" } });
    for (const [i, [rating, status]] of (
      [
        [5, "APPROVED"],
        [4, "APPROVED"],
        [1, "PENDING"],
        [1, "REJECTED"],
      ] as const
    ).entries())
      await prisma.review.create({
        data: { productId: p.id, authorName: "a", rating, status, authorEmail: `${i}@x.example` },
      });
    const r = await request(app).get("/api/v1/seo/jsonld?type=product&slug=ld");
    expect(r.status).toBe(200);
    expect(r.body["@type"]).toBe("Product");
    expect(r.body.name).toBe("LD Tee");
    expect(r.body.brand.name).toBe("Acme");
    expect(r.body.offers).toMatchObject({
      "@type": "Offer",
      price: "19.90",
      priceCurrency: "USD",
      availability: "https://schema.org/OutOfStock",
    });
    expect(r.body.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.5,
      reviewCount: 2,
    });
    expect(r.body.offers.url).toBe("https://shop.example.com/product/ld");
    expect((await request(app).get("/api/v1/seo/jsonld?type=product&slug=drft")).status).toBe(404);
  });

  it("BlogPosting, Organization, BreadcrumbList, and unsupported types", async () => {
    await prisma.blogPost.create({
      data: {
        slug: "bp",
        title: "Post",
        body: "",
        excerpt: "ex",
        authorName: "Ann",
        status: "PUBLISHED",
        tags: ["a", "b"],
      },
    });
    const b = await request(app).get("/api/v1/seo/jsonld?type=blogposting&slug=bp");
    expect(b.body).toMatchObject({
      "@type": "BlogPosting",
      headline: "Post",
      author: { name: "Ann" },
      keywords: "a, b",
    });
    expect(
      (await request(app).get("/api/v1/seo/jsonld?type=blogposting&slug=b-draft")).status,
    ).toBe(404);
    await prisma.storeSettings.upsert({
      where: { id: "store" },
      create: { id: "store", name: "Acme Store", supportEmail: "hi@acme.example" },
      update: { name: "Acme Store", supportEmail: "hi@acme.example" },
    });
    const o = await request(app).get("/api/v1/seo/jsonld?type=organization");
    expect(o.body).toMatchObject({
      "@type": "Organization",
      name: "Acme Store",
      email: "hi@acme.example",
    });
    const parent = await mkCategory("Parent");
    await mkCategory("Child", parent.id);
    const c = await request(app).get("/api/v1/seo/jsonld?type=category&slug=child");
    expect(c.body["@type"]).toBe("BreadcrumbList");
    expect(c.body.itemListElement.map((i: { name: string }) => i.name)).toEqual([
      "Home",
      "Parent",
      "Child",
    ]);
    expect(c.body.itemListElement[2]).toMatchObject({
      position: 3,
      item: "https://shop.example.com/category/child",
    });
    expect((await request(app).get("/api/v1/seo/jsonld?type=wat")).status).toBe(422);
    expect((await request(app).get("/api/v1/seo/jsonld?type=category&slug=zzz")).status).toBe(404);
  });
});
