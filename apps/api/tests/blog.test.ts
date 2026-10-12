import { beforeAll, describe, expect, it } from "vitest";
import {
  bootApp,
  createAdminWithRole,
  loginAdmin,
  prisma,
  request,
  type AdminSessionHandle,
} from "./helpers";
import { mkMedia } from "./contentFixtures";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: AdminSessionHandle;

beforeAll(async () => {
  const b = await bootApp();
  app = b.app;
  admin = await b.admin();
});

const create = (body: object) => admin.post("/api/v1/admin/blog", body);
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe("blog admin", () => {
  it("auto-generates unique slugs, sanitizes body, stores tags and cover", async () => {
    const cover = await mkMedia("cover.jpg");
    const a = await create({
      title: "Hello World!",
      body: '<p onclick="x()">Hi</p><script>alert(1)</script>',
      tags: ["news", "Sale"],
      coverMediaId: cover.id,
      status: "PUBLISHED",
      excerpt: "<b>short</b>",
    });
    expect(a.status).toBe(201);
    expect(a.body.slug).toBe("hello-world");
    expect(a.body.body).toBe("<p>Hi</p>");
    expect(a.body.excerpt).toBe("short");
    const b = await create({ title: "Hello World!" });
    expect(b.body.slug).toBe("hello-world-2");
    expect((await create({ title: "x", slug: "hello-world" })).status).toBe(409);
    expect((await create({ title: "x", slug: "Bad Slug" })).status).toBe(422);
    expect((await create({ title: "" })).status).toBe(422);
  });

  it("lists (without bodies), filters, updates and deletes", async () => {
    const list = await admin.get("/api/v1/admin/blog?status=PUBLISHED");
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].body).toBeUndefined();
    const id = list.body.items[0].id;
    expect((await admin.get(`/api/v1/admin/blog/${id}`)).body.body).toBe("<p>Hi</p>");
    const up = await admin.patch(`/api/v1/admin/blog/${id}`, {
      title: "Renamed",
      body: "<p>x</p><script>1</script>",
      seo: { title: "S" },
    });
    expect(up.body).toMatchObject({ title: "Renamed", body: "<p>x</p>" });
    expect((await admin.patch(`/api/v1/admin/blog/${id}`, { slug: "bad slug" })).status).toBe(422);
    const other = (await admin.get("/api/v1/admin/blog?q=hello-world-2")).body.items[0];
    expect(
      (await admin.patch(`/api/v1/admin/blog/${other.id}`, { slug: "hello-world" })).status,
    ).toBe(409);
    expect((await admin.del(`/api/v1/admin/blog/${other.id}`)).status).toBe(204);
    expect((await admin.get(`/api/v1/admin/blog/${other.id}`)).status).toBe(404);
  });
});

describe("public blog", () => {
  it("hides drafts and future-scheduled posts; shows past-scheduled ones", async () => {
    await prisma.blogPost.deleteMany({});
    await create({ title: "Live", status: "PUBLISHED", tags: ["a"] });
    await create({ title: "Draft", status: "DRAFT", tags: ["a"] });
    await create({ title: "Future", status: "PUBLISHED", publishAt: hours(24), tags: ["b"] });
    await create({
      title: "Past",
      status: "PUBLISHED",
      publishAt: hours(-24),
      tags: ["b"],
      body: "<p>past</p>",
    });
    const list = await request(app).get("/api/v1/blog");
    expect(list.body.items.map((p: { slug: string }) => p.slug).sort()).toEqual(["live", "past"]);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0].body).toBeUndefined();
    expect(
      (await request(app).get("/api/v1/blog?tag=b")).body.items.map(
        (p: { slug: string }) => p.slug,
      ),
    ).toEqual(["past"]);
    expect((await request(app).get("/api/v1/blog?pageSize=1&page=2")).body.items).toHaveLength(1);
    expect((await request(app).get("/api/v1/blog/live")).status).toBe(200);
    expect((await request(app).get("/api/v1/blog/past")).body.body).toBe("<p>past</p>");
    expect((await request(app).get("/api/v1/blog/draft")).status).toBe(404);
    expect((await request(app).get("/api/v1/blog/future")).status).toBe(404);
    expect((await request(app).get("/api/v1/blog/missing")).status).toBe(404);
  });

  it("is disabled by the blog feature flag", async () => {
    await prisma.storeSettings.upsert({
      where: { id: "store" },
      create: { id: "store", features: { blog: false } },
      update: { features: { blog: false } },
    });
    expect((await request(app).get("/api/v1/blog")).status).toBe(404);
    expect((await request(app).get("/api/v1/blog/live")).status).toBe(404);
    await prisma.storeSettings.update({ where: { id: "store" }, data: { features: {} } });
  });
});

describe("blog permissions", () => {
  it("blog.write for mutations; content.read for admin lists", async () => {
    await createAdminWithRole("CONTENT_MANAGER", "cm@x.example");
    await createAdminWithRole("SUPPORT", "sup@x.example");
    await createAdminWithRole("CATALOG_MANAGER", "cat@x.example");
    const cm = await loginAdmin(app, "cm@x.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup@x.example", "Another-Pass-123");
    const cat = await loginAdmin(app, "cat@x.example", "Another-Pass-123");
    expect((await cm.post("/api/v1/admin/blog", { title: "By CM" })).status).toBe(201);
    expect((await sup.get("/api/v1/admin/blog")).status).toBe(200);
    expect((await sup.post("/api/v1/admin/blog", { title: "nope" })).status).toBe(403);
    expect((await cat.get("/api/v1/admin/blog")).status).toBe(403);
  });
});
