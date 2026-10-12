import { beforeAll, describe, expect, it } from "vitest";
import {
  bootApp,
  createAdminWithRole,
  loginAdmin,
  prisma,
  request,
  type AdminSessionHandle,
} from "./helpers";
import { mkCategory, mkMedia } from "./contentFixtures";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: AdminSessionHandle;

beforeAll(async () => {
  const b = await bootApp();
  app = b.app;
  admin = await b.admin();
});

type Item = {
  label: string;
  url: string | null;
  children: Item[];
  promo?: Record<string, unknown> | null;
};
const pubMenu = async (q = "") => (await request(app).get(`/api/v1/navigation${q}`)).body;

describe("navigation tree", () => {
  it("saves a nested tree, reads it back and resolves targets to storefront paths", async () => {
    const men = await mkCategory("Men");
    const shirts = await mkCategory("Shirts", men.id);
    await mkCategory("Pants", men.id);
    await mkCategory("Retired", men.id, { isActive: false });
    const col = await prisma.collection.create({ data: { name: "Summer", slug: "summer" } });
    await prisma.page.create({ data: { slug: "about", title: "About", status: "PUBLISHED" } });
    const media = await mkMedia("promo.jpg");

    const put = await admin.put("/api/v1/admin/navigation/header", {
      items: [
        { label: "Home", type: "LINK", url: "/" },
        {
          label: "Men",
          type: "CATEGORY",
          categoryId: men.id,
          autoChildren: true,
          badge: "New",
          promo: { title: "Big sale", mediaId: media.id, url: "/sale", ctaLabel: "Go" },
          children: [{ label: "Shirts!", type: "CATEGORY", categorySlug: "shirts" }],
        },
        { label: "Summer", type: "COLLECTION", collectionSlug: "summer", showMobile: false },
        { label: "About", type: "PAGE", pageSlug: "about", openInNewTab: true },
        { label: "Ext", type: "LINK", url: "https://example.com", showDesktop: false },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.items).toHaveLength(5);
    expect(put.body.items[1].autoChildren).toBe(true);
    expect(put.body.items[1].promo._autoChildren).toBeUndefined();
    void col;
    void shirts;

    const adm = await admin.get("/api/v1/admin/navigation/header");
    expect(adm.body.items[1].children).toHaveLength(1);

    const body = await pubMenu();
    const items = body.items as Item[];
    expect(items.map((i) => i.url)).toEqual([
      "/",
      "/category/men",
      "/collection/summer",
      "/pages/about",
      "https://example.com",
    ]);
    // explicit "Shirts!" child + auto Pants (Shirts not duplicated, Retired inactive skipped)
    expect(items[1]!.children.map((c) => c.url)).toEqual(["/category/shirts", "/category/pants"]);
    expect(items[1]!.promo).toMatchObject({ title: "Big sale", url: "/sale" });
    expect(items[1]!.promo.mediaUrl).toMatch(/promo\.jpg$/);
    expect(JSON.stringify(body)).not.toContain("_autoChildren");
    // device flags are returned, not filtered
    expect(items[2]).toMatchObject({ showMobile: false, showDesktop: true });
    expect(items[3]).toMatchObject({ openInNewTab: true });
    expect(items[4]).toMatchObject({ showDesktop: false });
  });

  it("is cache friendly", async () => {
    const r = await request(app).get("/api/v1/navigation");
    expect(r.headers["cache-control"]).toMatch(/max-age=60/);
    expect(r.headers.etag).toBeTruthy();
    const again = await request(app)
      .get("/api/v1/navigation")
      .set("If-None-Match", r.headers.etag!);
    expect(again.status).toBe(304);
  });

  it("skips inactive items and links to inactive/missing/unpublished targets", async () => {
    const live = await mkCategory("Live");
    const dead = await mkCategory("Dead", null, { isActive: false });
    const col = await prisma.collection.create({
      data: { name: "Off", slug: "off", isActive: false },
    });
    await prisma.page.create({ data: { slug: "drafty", title: "D", status: "DRAFT" } });
    await prisma.page.create({
      data: {
        slug: "later",
        title: "L",
        status: "PUBLISHED",
        publishAt: new Date(Date.now() + 1e8),
      },
    });
    const put = await admin.put("/api/v1/admin/navigation/footer", {
      items: [
        { label: "Live", type: "CATEGORY", categoryId: live.id },
        { label: "Dead", type: "CATEGORY", categoryId: dead.id },
        { label: "Off", type: "COLLECTION", collectionId: col.id },
        { label: "Drafty", type: "PAGE", pageSlug: "drafty" },
        { label: "Later", type: "PAGE", pageSlug: "later" },
        { label: "Nope", type: "PAGE", pageSlug: "missing" },
        { label: "Inactive", type: "LINK", url: "/x", active: false },
        {
          label: "Parent",
          type: "MEGA",
          children: [
            { label: "gone", type: "LINK", url: "/g", active: false },
            { label: "stay", type: "LINK", url: "/s" },
          ],
        },
      ],
    });
    expect(put.status).toBe(200);
    const m = await pubMenu("?menu=footer");
    expect(m.items.map((i: Item) => i.label)).toEqual(["Live", "Parent"]);
    expect(m.items[1].children.map((i: Item) => i.label)).toEqual(["stay"]);
    // target deleted after save: item silently skipped
    await prisma.category.update({ where: { id: live.id }, data: { isActive: false } });
    expect((await pubMenu("?menu=footer")).items.map((i: Item) => i.label)).toEqual(["Parent"]);
  });

  it("returns all menus with menu=all, empty header by default, 404 for unknown", async () => {
    const all = await pubMenu("?menu=all");
    expect(all.menus.map((m: { key: string }) => m.key)).toEqual(
      expect.arrayContaining(["header", "footer"]),
    );
    await prisma.navigationMenu.deleteMany({});
    expect((await pubMenu()).items).toEqual([]);
    expect((await request(app).get("/api/v1/navigation?menu=zzz")).status).toBe(404);
  });

  it("validates: depth <= 4, types need targets, unknown targets, duplicate ids, unsafe urls", async () => {
    const deep = (n: number): object => ({
      label: `l${n}`,
      type: "MEGA",
      children: n > 1 ? [deep(n - 1)] : [],
    });
    expect((await admin.put("/api/v1/admin/navigation/custom", { items: [deep(4)] })).status).toBe(
      200,
    );
    const tooDeep = await admin.put("/api/v1/admin/navigation/custom", { items: [deep(5)] });
    expect(tooDeep.status).toBe(422);
    expect(JSON.stringify(tooDeep.body)).toMatch(/deeper than 4/);

    const bad = await admin.put("/api/v1/admin/navigation/custom", {
      items: [
        { label: "a", type: "LINK" },
        { label: "b", type: "CATEGORY", categorySlug: "nope" },
        { label: "c", type: "PAGE" },
        { label: "d", type: "LINK", url: "javascript:alert(1)" },
        { label: "e", type: "COLLECTION", collectionId: "nope" },
        { label: "f", type: "LINK", url: "/f", autoChildren: true },
        { label: "g", type: "LINK", url: "/g", promo: { title: "x", url: "/ok", extra: 1 } },
      ],
    });
    expect(bad.status).toBe(422);

    const dup = await admin.put("/api/v1/admin/navigation/custom", {
      items: [
        { id: "same", label: "a", type: "LINK", url: "/a" },
        { id: "same", label: "b", type: "LINK", url: "/b", children: [] },
      ],
    });
    expect(dup.status).toBe(422);
    expect(JSON.stringify(dup.body)).toMatch(/duplicate or cyclic/);
    // nested self-reference by id
    const cyc = await admin.put("/api/v1/admin/navigation/custom", {
      items: [
        {
          id: "p",
          label: "a",
          type: "MEGA",
          children: [{ id: "p", label: "b", type: "LINK", url: "/b" }],
        },
      ],
    });
    expect(cyc.status).toBe(422);
    expect((await admin.put("/api/v1/admin/navigation/Bad Key", { items: [] })).status).toBe(422);
  });

  it("save is replace-all and transactional (failed save keeps old tree)", async () => {
    await admin.put("/api/v1/admin/navigation/swap", {
      items: [{ label: "one", type: "LINK", url: "/1" }],
    });
    await admin.put("/api/v1/admin/navigation/swap", {
      items: [{ label: "two", type: "LINK", url: "/2" }],
    });
    expect((await pubMenu("?menu=swap")).items.map((i: Item) => i.label)).toEqual(["two"]);
    await admin.put("/api/v1/admin/navigation/swap", { items: [{ label: "bad", type: "LINK" }] });
    expect((await pubMenu("?menu=swap")).items.map((i: Item) => i.label)).toEqual(["two"]);
    // ids may be reused within the same menu
    const cur = await admin.get("/api/v1/admin/navigation/swap");
    const again = await admin.put("/api/v1/admin/navigation/swap", { items: cur.body.items });
    expect(again.status).toBe(200);
    expect(again.body.items[0].id).toBe(cur.body.items[0].id);
    // but not stolen from another menu
    const steal = await admin.put("/api/v1/admin/navigation/other", {
      items: [{ id: cur.body.items[0].id, label: "x", type: "LINK", url: "/x" }],
    });
    expect(steal.status).toBe(422);
  });
});

describe("navigation permissions", () => {
  it("navigation.write required for save; content.read for reads", async () => {
    await createAdminWithRole("CONTENT_MANAGER", "cm@x.example");
    await createAdminWithRole("SUPPORT", "sup@x.example");
    await createAdminWithRole("CATALOG_MANAGER", "cat@x.example");
    const cm = await loginAdmin(app, "cm@x.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup@x.example", "Another-Pass-123");
    const cat = await loginAdmin(app, "cat@x.example", "Another-Pass-123");
    const body = { items: [{ label: "x", type: "LINK", url: "/x" }] };
    expect((await cm.put("/api/v1/admin/navigation/perm", body)).status).toBe(200);
    expect((await sup.get("/api/v1/admin/navigation/perm")).status).toBe(200);
    expect((await sup.put("/api/v1/admin/navigation/perm", body)).status).toBe(403);
    expect((await cat.put("/api/v1/admin/navigation/perm", body)).status).toBe(403);
    expect((await cat.get("/api/v1/admin/navigation/perm")).status).toBe(403);
  });
});
