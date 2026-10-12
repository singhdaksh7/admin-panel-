import { beforeAll, describe, expect, it } from "vitest";
import {
  bootApp,
  createAdminWithRole,
  loginAdmin,
  request,
  type AdminSessionHandle,
} from "./helpers";
import { mkCategory, mkMedia, mkProduct } from "./contentFixtures";
import { prisma } from "./helpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: AdminSessionHandle;

beforeAll(async () => {
  const b = await bootApp();
  app = b.app;
  admin = await b.admin();
});

async function mkPage(slug = "home", status = "PUBLISHED", extra: object = {}) {
  const r = await admin.post("/api/v1/admin/pages", { slug, title: slug, status, ...extra });
  expect(r.status).toBe(201);
  return r.body as { id: string; slug: string };
}
const addSection = (pageId: string, body: object) =>
  admin.post(`/api/v1/admin/pages/${pageId}/sections`, body);

describe("section type validation", () => {
  let pageId: string;
  beforeAll(async () => {
    pageId = (await mkPage("validation", "DRAFT")).id;
  });

  const valid: Record<string, object> = {
    HERO: { heading: "Hi", cta: { label: "Shop", url: "/shop" }, image: { desktopMediaId: "x" } },
    PROMO_BANNER: { text: "Sale", backgroundColor: "#ff0000" },
    TEXT: { body: "<p>hello</p>" },
    IMAGE: { image: { desktopMediaId: "m1", mobileMediaId: "m2" }, linkUrl: "https://x.example" },
    PRODUCT_GRID: { productSlugs: ["a"], limit: 4 },
    CATEGORY_GRID: { categorySlugs: ["a"], limit: 4 },
    RICH_TEXT: { html: "<h2>x</h2>" },
    REVIEWS: { limit: 3 },
    BLOG_PREVIEW: { limit: 2 },
    CUSTOM_JSON: { anything: { goes: [1, 2] } },
  };
  it.each(Object.entries(valid))("accepts valid %s", async (type, content) => {
    const r = await addSection(pageId, { type, content });
    expect(r.status).toBe(201);
  });

  const invalid: [string, object, string][] = [
    ["HERO", { subheading: "no heading" }, "content.heading"],
    ["HERO", { heading: "x", cta: { label: "a", url: "javascript:alert(1)" } }, "content.cta.url"],
    ["HERO", { heading: "x", bogus: 1 }, "content"],
    ["PROMO_BANNER", { text: "x", backgroundColor: "red" }, "content.backgroundColor"],
    ["TEXT", { body: "" }, "content.body"],
    ["IMAGE", { image: { mobileMediaId: "m" } }, "content.image.desktopMediaId"],
    ["PRODUCT_GRID", { limit: 500 }, "content.limit"],
    ["PRODUCT_GRID", { productSlugs: ["Bad Slug"] }, "content.productSlugs.0"],
    ["CATEGORY_GRID", { limit: 0 }, "content.limit"],
    ["RICH_TEXT", {}, "content.html"],
    ["REVIEWS", { minRating: 9 }, "content.minRating"],
    ["BLOG_PREVIEW", { limit: "3" }, "content.limit"],
  ];
  it.each(invalid)("rejects invalid %s with precise path", async (type, content, path) => {
    const r = await addSection(pageId, { type, content });
    expect(r.status).toBe(422);
    const paths = (r.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toContain(path);
  });

  it("rejects unknown type and oversized CUSTOM_JSON (>64KB)", async () => {
    expect((await addSection(pageId, { type: "NOPE", content: {} })).status).toBe(422);
    const big = await addSection(pageId, {
      type: "CUSTOM_JSON",
      content: { blob: "x".repeat(70_000) },
    });
    expect(big.status).toBe(422);
    const ok = await addSection(pageId, {
      type: "CUSTOM_JSON",
      content: { blob: "x".repeat(60_000) },
    });
    expect(ok.status).toBe(201);
  });

  it("validates content on update using the section's own type", async () => {
    const s = await addSection(pageId, { type: "HERO", content: { heading: "h" } });
    const bad = await admin.patch(`/api/v1/admin/pages/${pageId}/sections/${s.body.id}`, {
      content: { heading: "" },
    });
    expect(bad.status).toBe(422);
    const ok = await admin.patch(`/api/v1/admin/pages/${pageId}/sections/${s.body.id}`, {
      content: { heading: "new" },
    });
    expect(ok.body.content.heading).toBe("new");
  });
});

describe("sanitization", () => {
  it("strips scripts, handlers and javascript: URLs from TEXT and RICH_TEXT", async () => {
    const { id } = await mkPage("xss", "PUBLISHED");
    const evil =
      '<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">l</a><img src=x onerror=alert(1)><iframe src="//e"></iframe>';
    const a = await addSection(id, { type: "TEXT", content: { body: evil } });
    const b = await addSection(id, { type: "RICH_TEXT", content: { html: evil } });
    for (const s of [a.body.content.body, b.body.content.html] as string[]) {
      expect(s).toContain("hi");
      expect(s).not.toMatch(/script|onclick|onerror|javascript:|iframe|alert/i);
    }
    const pub = await request(app).get("/api/v1/pages/xss");
    expect(JSON.stringify(pub.body)).not.toMatch(/<script|onerror|javascript:/i);
  });
});

describe("scheduling and publication", () => {
  it("hides sections outside their window, disabled ones, and orders by sortOrder", async () => {
    const { id } = await mkPage("sched");
    const past = new Date(Date.now() - 86400_000).toISOString();
    const future = new Date(Date.now() + 86400_000).toISOString();
    const c = (heading: string) => ({ heading });
    await addSection(id, { type: "HERO", key: "b", sortOrder: 2, content: c("b") });
    await addSection(id, { type: "HERO", key: "a", sortOrder: 1, content: c("a") });
    await addSection(id, { type: "HERO", key: "future", content: c("f"), startsAt: future });
    await addSection(id, { type: "HERO", key: "expired", content: c("e"), endsAt: past });
    await addSection(id, { type: "HERO", key: "disabled", content: c("d"), isEnabled: false });
    await addSection(id, {
      type: "HERO",
      key: "live",
      content: c("l"),
      startsAt: past,
      endsAt: future,
      sortOrder: 3,
    });
    const pub = await request(app).get("/api/v1/pages/sched");
    expect(pub.status).toBe(200);
    expect(pub.body.sections.map((s: { key: string }) => s.key)).toEqual(["a", "b", "live"]);
    // admin preview sees everything
    const adm = await admin.get(`/api/v1/admin/pages/${id}`);
    expect(adm.body.sections).toHaveLength(6);
  });

  it("rejects endsAt before startsAt", async () => {
    const { id } = await mkPage("window");
    const r = await addSection(id, {
      type: "HERO",
      content: { heading: "x" },
      startsAt: new Date(Date.now() + 2000).toISOString(),
      endsAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(r.status).toBe(422);
  });

  it("drafts and future-scheduled pages are 404 publicly but previewable by admin", async () => {
    await mkPage("draft-page", "DRAFT");
    await mkPage("future-page", "PUBLISHED", {
      publishAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    await mkPage("past-page", "PUBLISHED", {
      publishAt: new Date(Date.now() - 86400_000).toISOString(),
    });
    expect((await request(app).get("/api/v1/pages/draft-page")).status).toBe(404);
    expect((await request(app).get("/api/v1/pages/future-page")).status).toBe(404);
    expect((await request(app).get("/api/v1/pages/past-page")).status).toBe(200);
    const list = await request(app).get("/api/v1/pages");
    const slugs = list.body.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("past-page");
    expect(slugs).not.toContain("draft-page");
    expect(slugs).not.toContain("future-page");
    expect((await admin.get("/api/v1/admin/pages/draft-page")).status).toBe(200);
  });

  it("reorders sections and rejects incomplete reorder lists", async () => {
    const { id } = await mkPage("reorder");
    const ids: string[] = [];
    for (const k of ["x", "y", "z"])
      ids.push((await addSection(id, { type: "HERO", key: k, content: { heading: k } })).body.id);
    const r = await admin.put(`/api/v1/admin/pages/${id}/sections/reorder`, {
      ids: [ids[2], ids[0], ids[1]],
    });
    expect(r.status).toBe(200);
    expect(r.body.map((s: { key: string }) => s.key)).toEqual(["z", "x", "y"]);
    expect(
      (await admin.put(`/api/v1/admin/pages/${id}/sections/reorder`, { ids: [ids[0]] })).status,
    ).toBe(422);
    const pub = await request(app).get("/api/v1/pages/reorder");
    expect(pub.body.sections.map((s: { key: string }) => s.key)).toEqual(["z", "x", "y"]);
  });

  it("enforces slug uniqueness and deletes cascade", async () => {
    const { id } = await mkPage("dupe");
    expect((await admin.post("/api/v1/admin/pages", { slug: "dupe", title: "again" })).status).toBe(
      409,
    );
    await addSection(id, { type: "HERO", content: { heading: "x" } });
    expect((await admin.del(`/api/v1/admin/pages/${id}`)).status).toBe(204);
    expect(await prisma.pageSection.count({ where: { pageId: id } })).toBe(0);
  });
});

describe("public resolution", () => {
  it("resolves media urls and product/category/blog items without leaking drafts", async () => {
    const m1 = await mkMedia("hero-d.jpg");
    const m2 = await mkMedia("hero-m.jpg");
    const cat = await mkCategory("Shoes");
    const inactive = await mkCategory("Hidden", null, { isActive: false });
    await mkProduct({ slug: "live-1", categoryId: cat.id, mediaId: m1.id, price: "20.00" });
    await mkProduct({ slug: "live-2", categoryId: cat.id });
    await mkProduct({ slug: "draft-1", categoryId: cat.id, status: "DRAFT" });
    await mkProduct({
      slug: "future-1",
      categoryId: cat.id,
      publishAt: new Date(Date.now() + 86400_000),
    });
    await mkProduct({ slug: "archived-1", categoryId: cat.id, status: "ARCHIVED" });
    await prisma.blogPost.create({
      data: { slug: "pub-post", title: "Pub", body: "b", status: "PUBLISHED" },
    });
    await prisma.blogPost.create({
      data: { slug: "draft-post", title: "Draft", body: "b", status: "DRAFT" },
    });

    const { id } = await mkPage("resolved");
    await addSection(id, {
      type: "HERO",
      content: { heading: "H", image: { desktopMediaId: m1.id, mobileMediaId: m2.id } },
    });
    await addSection(id, { type: "PRODUCT_GRID", content: { categorySlug: "shoes", limit: 10 } });
    await addSection(id, {
      type: "PRODUCT_GRID",
      content: {
        productSlugs: ["live-2", "draft-1", "live-1", "future-1", "archived-1"],
        limit: 10,
      },
    });
    await addSection(id, {
      type: "CATEGORY_GRID",
      content: { categorySlugs: ["shoes", "hidden"] },
    });
    await addSection(id, { type: "BLOG_PREVIEW", content: { limit: 5 } });
    void inactive;

    const res = await request(app).get("/api/v1/pages/resolved");
    expect(res.status).toBe(200);
    const [hero, byCat, bySlug, cats, blog] = res.body.sections;
    expect(hero.content.image.desktopUrl).toMatch(/hero-d.jpg$/);
    expect(hero.content.image.mobileUrl).toMatch(/hero-m.jpg$/);
    expect(byCat.content.items.map((p: { slug: string }) => p.slug).sort()).toEqual([
      "live-1",
      "live-2",
    ]);
    expect(bySlug.content.items.map((p: { slug: string }) => p.slug)).toEqual(["live-2", "live-1"]);
    const live1 = bySlug.content.items[1];
    expect(live1.price).toBe("20.00");
    expect(live1.imageUrl).toMatch(/hero-d.jpg$/);
    expect(cats.content.items.map((c: { slug: string }) => c.slug)).toEqual(["shoes"]);
    expect(cats.content.items[0].url).toBe("/category/shoes");
    expect(blog.content.items.map((p: { slug: string }) => p.slug)).toEqual(["pub-post"]);
    const allItems = res.body.sections.flatMap(
      (s: { content: { items?: unknown[] } }) => s.content.items ?? [],
    );
    expect(JSON.stringify(allItems)).not.toMatch(/draft-1|future-1|archived-1|draft-post/);
  });
});

describe("permissions", () => {
  it("CONTENT_MANAGER can write; CATALOG_MANAGER cannot even read; SUPPORT can read only", async () => {
    await createAdminWithRole("CONTENT_MANAGER", "cm@x.example");
    await createAdminWithRole("CATALOG_MANAGER", "cat@x.example");
    await createAdminWithRole("SUPPORT", "sup@x.example");
    const cm = await loginAdmin(app, "cm@x.example", "Another-Pass-123");
    const cat = await loginAdmin(app, "cat@x.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup@x.example", "Another-Pass-123");
    expect((await cm.post("/api/v1/admin/pages", { slug: "cm-page", title: "T" })).status).toBe(
      201,
    );
    expect((await cm.get("/api/v1/admin/pages")).status).toBe(200);
    expect((await cat.get("/api/v1/admin/pages")).status).toBe(403);
    expect((await cat.post("/api/v1/admin/pages", { slug: "n", title: "T" })).status).toBe(403);
    expect((await sup.get("/api/v1/admin/pages")).status).toBe(200);
    expect((await sup.post("/api/v1/admin/pages", { slug: "n2", title: "T" })).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/pages")).status).toBe(401);
  });
});
