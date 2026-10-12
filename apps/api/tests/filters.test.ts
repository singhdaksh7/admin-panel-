import { beforeAll, describe, expect, it } from "vitest";
import {
  bootApp,
  createAdminWithRole,
  loginAdmin,
  prisma,
  request,
  type AdminSessionHandle,
} from "./helpers";
import { mkAttribute, mkCategory, mkProduct } from "./contentFixtures";
import { buildProductWhere, parseFilters } from "../src/lib/productQuery";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: AdminSessionHandle;
let men: { id: string };
let shirts: { id: string };
let pants: { id: string };
let color: { id: string; values: { id: string; slug: string }[] };

const base = {
  category: true,
  collection: true,
  tag: true,
};
void base;

beforeAll(async () => {
  const b = await bootApp();
  app = b.app;
  admin = await b.admin();
  men = await mkCategory("Men");
  shirts = await mkCategory("Shirts", men.id);
  pants = await mkCategory("Pants", men.id);
  const women = await mkCategory("Women");
  color = (await mkAttribute("Color", ["red", "blue", "green"])) as never;
  const v = Object.fromEntries(color.values.map((x) => [x.slug, x.id]));
  const sale = await prisma.tag.create({ data: { name: "Sale", slug: "sale" } });
  const fresh = await prisma.tag.create({ data: { name: "New", slug: "new" } });
  const summer = await prisma.collection.create({ data: { name: "Summer", slug: "summer" } });
  await mkProduct({
    slug: "p1",
    categoryId: shirts.id,
    price: "10.00",
    onHand: 5,
    tagIds: [sale.id],
    variantAttributeValueIds: [v.red!],
    collectionIds: [summer.id],
    properties: { fit: "slim" },
  });
  await mkProduct({
    slug: "p2",
    categoryId: shirts.id,
    price: "30.00",
    onHand: 0,
    tagIds: [sale.id, fresh.id],
    attributeValueIds: [v.blue!],
    properties: { fit: "regular" },
  });
  await mkProduct({
    slug: "p3",
    categoryId: pants.id,
    price: "50.00",
    onHand: 3,
    tagIds: [fresh.id],
    attributeValueIds: [v.red!],
    variantAttributeValueIds: [v.red!],
    properties: { fit: "slim" },
  });
  await mkProduct({
    slug: "p4",
    categoryId: pants.id,
    status: "DRAFT",
    price: "5.00",
    onHand: 9,
    tagIds: [sale.id],
    variantAttributeValueIds: [v.red!],
    properties: { fit: "slim" },
  });
  await mkProduct({
    slug: "p5",
    categoryId: women.id,
    price: "100.00",
    onHand: null,
    variantAttributeValueIds: [v.green!],
    properties: { fit: "slim" },
  });
});

const getFilters = async (q: Record<string, string> = {}) => {
  const res = await request(app).get("/api/v1/filters").query(q);
  expect(res.status).toBe(200);
  return res.body as {
    category: { slug: string } | null;
    groups: {
      key: string;
      source: string;
      label: string;
      type: string;
      open: boolean;
      options: { value: string; label: string; count: number; selected: boolean }[];
      range?: { min: string; max: string };
    }[];
  };
};
const grp = (r: Awaited<ReturnType<typeof getFilters>>, key: string) =>
  r.groups.find((g) => g.key === key);
const counts = (g?: { options: { value: string; count: number }[] }) =>
  Object.fromEntries((g?.options ?? []).map((o) => [o.value, o.count]));

async function setScope(scope: string, groups: object[]) {
  const r = await admin.put(`/api/v1/admin/filters/scope/${scope}`, { groups });
  expect(r.status).toBe(200);
  return r.body.items;
}

describe("global defaults and counts", () => {
  beforeAll(async () => {
    await setScope("global", [
      { source: "CATEGORY", label: "Category", multiSelect: false },
      { source: "PRICE", label: "Price" },
      { source: "STOCK", label: "In stock" },
      { source: "ATTRIBUTE", attributeId: color.id, label: "Color" },
      { source: "TAG", label: "Tags" },
      { source: "COLLECTION", label: "Collection" },
      { source: "PROPERTY", propertyKey: "fit", label: "Fit" },
    ]);
  });

  it("returns hand-computed counts (drafts excluded, variant/product-level deduped)", async () => {
    const r = await getFilters();
    expect(r.category).toBeNull();
    expect(r.groups.map((g) => g.key)).toEqual([
      "category",
      "price",
      "inStock",
      "attr.color",
      "tag",
      "collection",
      "prop.fit",
    ]);
    expect(counts(grp(r, "category"))).toEqual({ men: 3, women: 1 });
    expect(grp(r, "price")!.range).toEqual({ min: "10.00", max: "100.00" });
    expect(grp(r, "price")!.type).toBe("range");
    expect(grp(r, "inStock")!.options[0]).toMatchObject({ count: 3, selected: false });
    expect(counts(grp(r, "attr.color"))).toEqual({ red: 2, blue: 1, green: 1 });
    expect(counts(grp(r, "tag"))).toEqual({ sale: 2, new: 2 });
    expect(counts(grp(r, "collection"))).toEqual({ summer: 1 });
    expect(counts(grp(r, "prop.fit"))).toEqual({ slim: 3, regular: 1 });
    expect(grp(r, "attr.color")!.type).toBe("multi");
    expect(grp(r, "category")!.type).toBe("single");
  });

  it("faceted: a group ignores its own selection but honors the others", async () => {
    const r = await getFilters({ "attr.color": "red" });
    expect(counts(grp(r, "attr.color"))).toEqual({ red: 2, blue: 1, green: 1 });
    expect(grp(r, "attr.color")!.options.find((o) => o.value === "red")!.selected).toBe(true);
    expect(counts(grp(r, "tag"))).toEqual({ sale: 1, new: 1 }); // red & sale = p1; red & new = p3
    expect(grp(r, "price")!.range).toEqual({ min: "10.00", max: "50.00" });
    const priced = await getFilters({ minPrice: "20", maxPrice: "60" });
    expect(counts(grp(priced, "tag"))).toEqual({ sale: 1, new: 2 });
    // price group ignores its own min/max
    expect(grp(priced, "price")!.range).toEqual({ min: "10.00", max: "100.00" });
  });

  it("hides zero-count options unless selected", async () => {
    const r = await getFilters({ category: "men" });
    expect(counts(grp(r, "attr.color"))).toEqual({ red: 2, blue: 1 }); // green only in women
    const sel = await getFilters({ category: "men", "attr.color": "green" });
    const green = grp(sel, "attr.color")!.options.find((o) => o.value === "green");
    expect(green).toMatchObject({ count: 0, selected: true });
    // single-selection tags: selecting a tag keeps it listed
    const t = await getFilters({ category: "women", tag: "sale" });
    expect(grp(t, "tag")!.options.find((o) => o.value === "sale")).toMatchObject({
      count: 0,
      selected: true,
    });
  });

  it("category group lists child categories of the current category with subtree counts", async () => {
    const r = await getFilters({ category: "men" });
    expect(counts(grp(r, "category"))).toEqual({ shirts: 2, pants: 1 });
    expect(
      (await getFilters({ category: "shirts" })).groups.find((g) => g.key === "category"),
    ).toBeUndefined();
    expect((await request(app).get("/api/v1/filters?category=nope")).status).toBe(404);
  });

  it("stock group: inStock selected keeps count of in-stock matches", async () => {
    const r = await getFilters({ inStock: "true" });
    expect(grp(r, "inStock")!.options[0]).toMatchObject({ count: 3, selected: true });
    expect(counts(grp(r, "tag"))).toEqual({ sale: 1, new: 1 }); // in stock only: p1 sale, p3 new
  });

  it("every option count equals the length of the equivalent product list (oracle)", async () => {
    const queries: Record<string, string>[] = [
      {},
      { category: "men" },
      { category: "men", "attr.color": "red" },
      { tag: "sale" },
      { "attr.color": "blue", inStock: "true" },
      { collection: "summer", "prop.fit": "slim" },
      { minPrice: "20", category: "men" },
      { "prop.fit": "slim", tag: "new", maxPrice: "60" },
    ];
    for (const q of queries) {
      const r = await getFilters(q);
      for (const g of r.groups) {
        if (g.type === "range") {
          const where = await buildProductWhere(
            prisma,
            parseFilters(omitKeys(q, ["minPrice", "maxPrice"])),
          );
          const vs = await prisma.productVariant.findMany({
            where: { isActive: true, product: where },
          });
          const prices = vs.map((v) => Number(v.price));
          expect(Number(g.range!.min)).toBe(Math.min(...prices));
          expect(Number(g.range!.max)).toBe(Math.max(...prices));
          continue;
        }
        for (const o of g.options) {
          let own: Record<string, string>;
          if (g.key === "inStock") own = { ...omitKeys(q, ["inStock"]), inStock: "true" };
          else if (g.key === "tag") own = { ...omitKeys(q, ["tag"]), tag: o.value };
          else own = { ...omitKeys(q, [g.key]), [g.key]: o.value };
          const expected = await prisma.product.count({
            where: await buildProductWhere(prisma, parseFilters(own)),
          });
          expect(o.count, `${JSON.stringify(q)} ${g.key}=${o.value}`).toBe(expected);
        }
      }
    }
  });
});

function omitKeys(q: Record<string, string>, keys: string[]) {
  return Object.fromEntries(Object.entries(q).filter(([k]) => !keys.includes(k)));
}

describe("inheritance, overrides and device flags", () => {
  it("resolves own + inherited groups; nearest wins; own disabled overrides inherited; non-inheriting stops", async () => {
    await setScope(men.id, [
      { source: "PRICE", label: "Men price" },
      { source: "ATTRIBUTE", attributeId: color.id, label: "Men color" },
      { source: "TAG", label: "Men tag", isEnabled: false },
      { source: "STOCK", label: "Men stock", inheritToChildren: false },
    ]);
    await setScope(shirts.id, [
      { source: "ATTRIBUTE", attributeId: color.id, label: "Shirt color", sortOrder: 0 },
      { source: "PRICE", label: "x", isEnabled: false },
      { source: "TAG", label: "Shirt tag", sortOrder: 1 },
    ]);

    const menR = await getFilters({ category: "men" });
    expect(menR.groups.map((g) => [g.key, g.label])).toEqual([
      ["price", "Men price"],
      ["attr.color", "Men color"],
      ["inStock", "Men stock"],
    ]);
    const shirtR = await getFilters({ category: "shirts" });
    expect(shirtR.groups.map((g) => [g.key, g.label])).toEqual([
      ["attr.color", "Shirt color"],
      ["tag", "Shirt tag"],
    ]); // price disabled by override, stock not inherited, tag re-enabled by own def
    const pantsR = await getFilters({ category: "pants" });
    expect(pantsR.groups.map((g) => [g.key, g.label])).toEqual([
      ["price", "Men price"],
      ["attr.color", "Men color"],
    ]); // Men's disabled tag stays disabled; stock does not inherit
    // category with nothing configured in chain -> global defaults
    const women = await getFilters({ category: "women" });
    expect(women.groups.map((g) => g.key)).toContain("prop.fit");

    const eff = await admin.get(`/api/v1/admin/filters/effective/${pants.id}`);
    expect(eff.body.items.map((g: { label: string }) => g.label)).toEqual([
      "Men price",
      "Men color",
    ]);
  });

  it("honors device=mobile|desktop", async () => {
    await setScope(men.id, [
      { source: "PRICE", label: "Price", showMobile: false },
      { source: "ATTRIBUTE", attributeId: color.id, label: "Color", showDesktop: false },
      { source: "TAG", label: "Tag" },
    ]);
    const keys = async (device?: string) =>
      (await getFilters({ category: "men", ...(device ? { device } : {}) })).groups.map(
        (g) => g.key,
      );
    expect(await keys()).toEqual(["price", "attr.color", "tag"]);
    expect(await keys("mobile")).toEqual(["attr.color", "tag"]);
    expect(await keys("desktop")).toEqual(["price", "tag"]);
    const open = await getFilters({ category: "men" });
    expect(open.groups[0]!.open).toBe(true);
  });

  it("single-select flag changes the group type; defaultOpen is reported", async () => {
    await setScope(pants.id, [
      { source: "TAG", label: "Tag", multiSelect: false, defaultOpen: false },
    ]);
    const r = await getFilters({ category: "pants" });
    expect(r.groups.map((g) => g.key).sort()).toEqual(["attr.color", "price", "tag"]);
    expect(grp(r, "tag")).toMatchObject({ type: "single", open: false });
  });
});

describe("filter admin CRUD and permissions", () => {
  it("validates source-specific fields and supports single CRUD", async () => {
    expect(
      (await admin.post("/api/v1/admin/filters", { source: "ATTRIBUTE", label: "x" })).status,
    ).toBe(422);
    expect(
      (
        await admin.post("/api/v1/admin/filters", {
          source: "ATTRIBUTE",
          attributeId: "nope",
          label: "x",
        })
      ).status,
    ).toBe(422);
    expect(
      (await admin.post("/api/v1/admin/filters", { source: "PROPERTY", label: "x" })).status,
    ).toBe(422);
    expect(
      (await admin.post("/api/v1/admin/filters", { source: "TAG", label: "x", categoryId: "nope" }))
        .status,
    ).toBe(404);
    const dup = await admin.put("/api/v1/admin/filters/scope/global", {
      groups: [
        { source: "TAG", label: "a" },
        { source: "TAG", label: "b" },
      ],
    });
    expect(dup.status).toBe(422);
    const c = await admin.post("/api/v1/admin/filters", {
      source: "TAG",
      label: "Mine",
      categoryId: women().id,
    });
    expect(c.status).toBe(201);
    const p = await admin.patch(`/api/v1/admin/filters/${c.body.id}`, {
      label: "Renamed",
      isEnabled: false,
    });
    expect(p.body).toMatchObject({ label: "Renamed", isEnabled: false });
    expect(
      (await admin.get(`/api/v1/admin/filters?categoryId=${women().id}`)).body.items,
    ).toHaveLength(1);
    expect((await admin.del(`/api/v1/admin/filters/${c.body.id}`)).status).toBe(204);
  });

  it("CATALOG_MANAGER may write filters; SUPPORT and CONTENT_MANAGER may not", async () => {
    await createAdminWithRole("CATALOG_MANAGER", "cat@x.example");
    await createAdminWithRole("SUPPORT", "sup@x.example");
    await createAdminWithRole("CONTENT_MANAGER", "cm@x.example");
    const cat = await loginAdmin(app, "cat@x.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup@x.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm@x.example", "Another-Pass-123");
    const body = { groups: [{ source: "PRICE", label: "Price" }] };
    expect((await cat.put("/api/v1/admin/filters/scope/global", body)).status).toBe(200);
    expect((await sup.put("/api/v1/admin/filters/scope/global", body)).status).toBe(403);
    expect((await cm.put("/api/v1/admin/filters/scope/global", body)).status).toBe(403);
    expect((await sup.get("/api/v1/admin/filters")).status).toBe(403);
  });
});

function women() {
  return { id: womenId };
}
let womenId = "";
beforeAll(async () => {
  womenId = (await prisma.category.findUniqueOrThrow({ where: { slug: "women" } })).id;
});
