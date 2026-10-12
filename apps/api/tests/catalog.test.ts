import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let a: Awaited<ReturnType<Awaited<ReturnType<typeof bootApp>>["admin"]>>;
const B = "/api/v1/admin";

beforeAll(async () => {
  const boot = await bootApp();
  app = boot.app;
  a = await boot.admin();
});

async function mkProduct(body: Record<string, unknown>) {
  const r = await a.post(`${B}/products`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe("categories", () => {
  it("builds a tree, auto slugs, prevents cycles, and guards deletes", async () => {
    const root = (await a.post(`${B}/categories`, { name: "Books & Co" })).body;
    expect(root.slug).toBe("books-co");
    const dup = (await a.post(`${B}/categories`, { name: "Books & Co" })).body;
    expect(dup.slug).toBe("books-co-2");
    expect((await a.post(`${B}/categories`, { name: "X", slug: "books-co" })).status).toBe(409);
    const child = (await a.post(`${B}/categories`, { name: "Fiction", parentId: root.id })).body;
    const grand = (await a.post(`${B}/categories`, { name: "Sci-Fi", parentId: child.id })).body;

    const tree = (await a.get(`${B}/categories`)).body.items;
    const r = tree.find((c: { id: string }) => c.id === root.id);
    expect(r.children[0].children[0].id).toBe(grand.id);

    // cycles
    expect((await a.patch(`${B}/categories/${root.id}`, { parentId: grand.id })).status).toBe(422);
    expect((await a.patch(`${B}/categories/${root.id}`, { parentId: root.id })).status).toBe(422);

    // delete blocked: children, then products
    expect((await a.del(`${B}/categories/${root.id}`)).status).toBe(409);
    await mkProduct({ title: "Dune", price: "10.00", categoryId: grand.id });
    expect((await a.del(`${B}/categories/${grand.id}`)).status).toBe(409);
    expect((await a.del(`${B}/categories/${grand.id}?reassignTo=${child.id}`)).status).toBe(204);
    expect(await prisma.product.count({ where: { categoryId: child.id } })).toBe(1);

    // reorder
    const re = await a.post(`${B}/categories/reorder`, {
      items: [{ id: dup.id, sortOrder: -1 }],
    });
    expect(re.status).toBe(200);
    expect((await a.get(`${B}/categories`)).body.items[0].id).toBe(dup.id);
  });
});

describe("attributes", () => {
  it("CRUD with values, guards usage", async () => {
    const c = await a.post(`${B}/attributes`, {
      name: "Color",
      usedForVariants: true,
      values: [{ value: "Red" }, { value: "Blue", meta: { hex: "#00f" } }],
    });
    expect(c.status).toBe(201);
    expect(c.body.slug).toBe("color");
    expect(c.body.values).toHaveLength(2);
    const v = await a.post(`${B}/attributes/${c.body.id}/values`, { value: "Green" });
    expect(v.status).toBe(201);
    expect((await a.post(`${B}/attributes/${c.body.id}/values`, { value: "Green" })).status).toBe(
      409,
    );
    expect(
      (await a.patch(`${B}/attribute-values/${v.body.id}`, { value: "Lime" })).body.value,
    ).toBe("Lime");
    expect((await a.get(`${B}/attributes`)).body.items.length).toBeGreaterThan(0);

    const p = await mkProduct({
      title: "Used attr",
      variants: [
        { sku: "UA-1", price: "5.00", attributeValueIds: [c.body.values[0].id] },
        { sku: "UA-2", price: "5.00", attributeValueIds: [c.body.values[1].id] },
      ],
    });
    expect(p.variants).toHaveLength(2);
    expect((await a.del(`${B}/attribute-values/${c.body.values[0].id}`)).status).toBe(409);
    expect((await a.del(`${B}/attributes/${c.body.id}`)).status).toBe(409);
    expect((await a.del(`${B}/attribute-values/${v.body.id}`)).status).toBe(204);
  });

  it("tax classes CRUD", async () => {
    const t = await a.post(`${B}/tax-classes`, { name: "GST 18", rate: "18", hsnCode: "4901" });
    expect(t.status).toBe(201);
    expect(t.body.rate).toBe("18");
    expect((await a.post(`${B}/tax-classes`, { name: "GST 18", rate: "18" })).status).toBe(409);
    expect((await a.patch(`${B}/tax-classes/${t.body.id}`, { rate: "12.5" })).body.rate).toBe(
      "12.5",
    );
    const p = await mkProduct({ title: "Taxed", price: "1.00", taxClassId: t.body.id });
    expect(p.taxClass.name).toBe("GST 18");
    expect((await a.del(`${B}/tax-classes/${t.body.id}`)).status).toBe(409);
  });
});

describe("products and variants", () => {
  it("creates a simple product with an automatic default variant and stock", async () => {
    const p = await mkProduct({
      title: "Simple <b>Thing</b>",
      price: "19.99",
      compareAtPrice: "25.00",
      cost: "7.50",
      sku: "SIMPLE-1",
      stock: 12,
      tags: ["Hot Deal", "hot deal", "New"],
      description: '<p>ok</p><script>alert(1)</script><a href="javascript:x" onclick="y()">z</a>',
      shortDescription: "<i>short</i>",
    });
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0].isDefault).toBe(true);
    expect(p.variants[0].price).toBe("19.99");
    expect(p.variants[0].cost).toBe("7.50");
    expect(p.variants[0].inventory.onHand).toBe(12);
    expect(p.status).toBe("DRAFT");
    expect(p.tags.map((t: { slug: string }) => t.slug).sort()).toEqual(["hot-deal", "new"]);
    expect(p.description).not.toMatch(/script|javascript|onclick/);
    expect(p.shortDescription).toBe("short");
    const mv = await prisma.inventoryMovement.findMany({ where: { reason: "Initial stock" } });
    expect(mv.some((m) => m.onHandAfter === 12)).toBe(true);
  });

  it("validates money, sku uniqueness, slug and combinations", async () => {
    expect((await a.post(`${B}/products`, { title: "x", price: "1.234" })).status).toBe(422);
    expect((await a.post(`${B}/products`, { title: "x", price: 12.5 })).status).toBe(422);
    expect((await a.post(`${B}/products`, { title: "x" })).status).toBe(422);
    expect(
      (await a.post(`${B}/products`, { title: "x", price: "5", compareAtPrice: "4" })).status,
    ).toBe(422);
    await mkProduct({ title: "Sku One", price: "5.00", sku: "UNIQ-1", slug: "sku-one" });
    expect((await a.post(`${B}/products`, { title: "b", price: "5", sku: "UNIQ-1" })).status).toBe(
      409,
    );
    expect(
      (await a.post(`${B}/products`, { title: "b", price: "5", slug: "sku-one" })).status,
    ).toBe(409);
    // slug auto-suffix
    const again = await mkProduct({ title: "Sku One", price: "5.00" });
    expect(again.slug).toBe("sku-one-2");

    const size = (
      await a.post(`${B}/attributes`, {
        name: "Size",
        usedForVariants: true,
        values: [{ value: "S" }, { value: "M" }],
      })
    ).body;
    const [s, m] = size.values;
    // duplicate combination
    expect(
      (
        await a.post(`${B}/products`, {
          title: "Tee",
          variants: [
            { sku: "T-1", price: "9", attributeValueIds: [s.id] },
            { sku: "T-2", price: "9", attributeValueIds: [s.id] },
          ],
        })
      ).status,
    ).toBe(409);
    // multi-variants need combos
    expect(
      (
        await a.post(`${B}/products`, {
          title: "Tee",
          variants: [
            { sku: "T-1", price: "9" },
            { sku: "T-2", price: "9" },
          ],
        })
      ).status,
    ).toBe(422);
    // duplicate sku within payload
    expect(
      (
        await a.post(`${B}/products`, {
          title: "Tee",
          variants: [
            { sku: "T-1", price: "9", attributeValueIds: [s.id] },
            { sku: "T-1", price: "9", attributeValueIds: [m.id] },
          ],
        })
      ).status,
    ).toBe(409);
  });

  it("manages variants: add, update, conflicts, delete rules", async () => {
    const size = (
      await a.post(`${B}/attributes`, {
        name: "Fit",
        values: [{ value: "Slim" }, { value: "Regular" }, { value: "Loose" }],
      })
    ).body;
    const [slim, regular, loose] = size.values;
    const p = await mkProduct({ title: "Jeans", price: "40.00", sku: "JEANS-0" });
    const def = p.variants[0];

    // existing variant has no attributes -> must assign first
    expect(
      (
        await a.post(`${B}/products/${p.id}/variants`, {
          sku: "JEANS-S",
          price: "41",
          attributeValueIds: [slim.id],
        })
      ).status,
    ).toBe(422);
    const set = await a.patch(`${B}/products/${p.id}/variants/${def.id}`, {
      attributeValueIds: [regular.id],
      title: "Regular",
    });
    expect(set.status).toBe(200);
    const add = await a.post(`${B}/products/${p.id}/variants`, {
      sku: "JEANS-S",
      price: "41",
      stock: 3,
      attributeValueIds: [slim.id],
    });
    expect(add.status).toBe(201);
    expect(add.body.inventory.onHand).toBe(3);
    expect(
      (
        await a.post(`${B}/products/${p.id}/variants`, {
          sku: "JEANS-X",
          price: "41",
          attributeValueIds: [slim.id],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await a.post(`${B}/products/${p.id}/variants`, {
          sku: "JEANS-S",
          price: "41",
          attributeValueIds: [loose.id],
        })
      ).status,
    ).toBe(409);
    const upd = await a.patch(`${B}/products/${p.id}/variants/${add.body.id}`, {
      price: "43.50",
      isActive: false,
      cost: null,
    });
    expect(upd.body.price).toBe("43.50");
    expect(upd.body.isActive).toBe(false);
    // delete default promotes another; last variant protected
    expect((await a.del(`${B}/products/${p.id}/variants/${def.id}`)).status).toBe(204);
    const after = (await a.get(`${B}/products/${p.id}`)).body;
    expect(after.variants).toHaveLength(1);
    expect(after.variants[0].isDefault).toBe(true);
    expect((await a.del(`${B}/products/${p.id}/variants/${add.body.id}`)).status).toBe(409);
  });

  it("lists with pagination bound, search, status, category and sort", async () => {
    const cat = (await a.post(`${B}/categories`, { name: "ListCat" })).body;
    await mkProduct({ title: "Zeta Item", price: "30", categoryId: cat.id, status: "ACTIVE" });
    await mkProduct({ title: "Alpha Item", price: "10", categoryId: cat.id });
    const all = await a.get(`${B}/products?pageSize=1000`);
    expect(all.body.pageSize).toBe(100);
    const q = await a.get(`${B}/products?q=alpha`);
    expect(q.body.items.map((i: { title: string }) => i.title)).toEqual(["Alpha Item"]);
    const st = await a.get(`${B}/products?status=ACTIVE&category=${cat.slug}`);
    expect(st.body.items).toHaveLength(1);
    const sorted = await a.get(`${B}/products?category=${cat.id}&sort=price_asc`);
    expect(sorted.body.items.map((i: { priceMin: string }) => i.priceMin)).toEqual([
      "10.00",
      "30.00",
    ]);
    expect((await a.get(`${B}/products?status=BOGUS`)).status).toBe(422);
  });

  it("updates, bulk status, duplicates and deletes", async () => {
    const p = await mkProduct({ title: "Mutable", price: "5.00", sku: "MUT-1", stock: 4 });
    const u = await a.patch(`${B}/products/${p.id}`, {
      title: "Mutable 2",
      price: "6.00",
      sku: "MUT-1B",
      tags: ["x"],
      brand: "Acme",
      publishAt: "2030-01-01T00:00:00.000Z",
    });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.variants[0].price).toBe("6.00");
    expect(u.body.variants[0].sku).toBe("MUT-1B");
    expect(u.body.visibility).toBe("hidden");
    expect(
      (
        await a.patch(`${B}/products/${p.id}`, {
          publishAt: "2030-01-01T00:00:00.000Z",
          unpublishAt: "2029-01-01T00:00:00.000Z",
        })
      ).status,
    ).toBe(422);

    const bulk = await a.post(`${B}/products/bulk-status`, { ids: [p.id], status: "ACTIVE" });
    expect(bulk.body.updated).toBe(1);
    expect((await a.get(`${B}/products/${p.id}`)).body.visibility).toBe("scheduled");

    const dup = await a.post(`${B}/products/${p.id}/duplicate`);
    expect(dup.status).toBe(201);
    expect(dup.body.status).toBe("DRAFT");
    expect(dup.body.title).toBe("Copy of Mutable 2");
    expect(dup.body.variants[0].sku).toBe("MUT-1B-COPY");
    expect(dup.body.variants[0].inventory.onHand).toBe(0);

    expect((await a.del(`${B}/products/${dup.body.id}`)).status).toBe(204);
    expect((await a.get(`${B}/products/${dup.body.id}`)).status).toBe(404);
    const audits = await prisma.auditLog.count({ where: { action: "product.update" } });
    expect(audits).toBeGreaterThan(0);
  });
});

describe("collections", () => {
  it("manual membership and rule collections", async () => {
    const cat = (await a.post(`${B}/categories`, { name: "RuleCat" })).body;
    const p1 = await mkProduct({
      title: "R1",
      price: "10",
      categoryId: cat.id,
      status: "ACTIVE",
      tags: ["promo"],
    });
    const p2 = await mkProduct({ title: "R2", price: "99", categoryId: cat.id, status: "ACTIVE" });
    const man = (await a.post(`${B}/collections`, { name: "Hand Picked" })).body;
    expect(
      (await a.post(`${B}/collections/${man.id}/products`, { productIds: [p2.id, p1.id] })).status,
    ).toBe(201);
    expect(
      (await a.put(`${B}/collections/${man.id}/products/order`, { productIds: [p1.id, p2.id] }))
        .status,
    ).toBe(200);
    const members = (await a.get(`${B}/collections/${man.id}/products`)).body.items;
    expect(members.map((m: { id: string }) => m.id)).toEqual([p1.id, p2.id]);
    const pub = await request(app).get(`/api/v1/collections/${man.slug}`);
    expect(pub.body.products.items.map((i: { id: string }) => i.id)).toEqual([p1.id, p2.id]);
    expect((await a.del(`${B}/collections/${man.id}/products/${p1.id}`)).status).toBe(204);

    const rule = await a.post(`${B}/collections`, {
      name: "Cheap In Cat",
      type: "RULE",
      rules: {
        match: "all",
        conditions: [
          { field: "category", value: cat.slug },
          { field: "price", op: "lte", value: "50" },
        ],
      },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const rp = await request(app).get(`/api/v1/collections/${rule.body.slug}`);
    expect(rp.body.products.items.map((i: { id: string }) => i.id)).toEqual([p1.id]);
    const anyRule = await a.post(`${B}/collections`, {
      name: "Any",
      type: "RULE",
      rules: {
        match: "any",
        conditions: [
          { field: "tag", value: "promo" },
          { field: "price", op: "gte", value: "90" },
        ],
      },
    });
    const ap = await request(app).get(`/api/v1/collections/${anyRule.body.slug}`);
    expect(ap.body.products.total).toBe(2);
    expect((await a.post(`${B}/collections`, { name: "bad", type: "RULE" })).status).toBe(422);
    expect(
      (await a.post(`${B}/collections/${rule.body.id}/products`, { productIds: [p1.id] })).status,
    ).toBe(409);
    expect((await request(app).get("/api/v1/collections")).body.items.length).toBe(3);
  });
});

describe("permissions", () => {
  it("catalog manager can write; support is read-only; anonymous blocked", async () => {
    await createAdminWithRole("CATALOG_MANAGER", "cm@x.example");
    await createAdminWithRole("SUPPORT", "sup@x.example");
    const cm = await loginAdmin(app, "cm@x.example", "Another-Pass-123");
    const sup = await loginAdmin(app, "sup@x.example", "Another-Pass-123");
    expect((await cm.post(`${B}/categories`, { name: "CM Cat" })).status).toBe(201);
    expect((await cm.post(`${B}/products`, { title: "CM P", price: "1" })).status).toBe(201);
    expect((await sup.get(`${B}/products`)).status).toBe(200);
    expect((await sup.get(`${B}/categories`)).status).toBe(200);
    expect((await sup.post(`${B}/products`, { title: "S", price: "1" })).status).toBe(403);
    expect((await sup.post(`${B}/categories`, { name: "S" })).status).toBe(403);
    expect((await sup.post(`${B}/collections`, { name: "S" })).status).toBe(403);
    expect((await sup.post(`${B}/attributes`, { name: "S" })).status).toBe(403);
    expect((await sup.post(`${B}/tax-classes`, { name: "S", rate: "1" })).status).toBe(403);
    expect((await request(app).get(`${B}/products`)).status).toBe(401);
  });
});

describe("public catalog API", () => {
  it("shows only published products, hides cost and internals, supports filters", async () => {
    const root = (await a.post(`${B}/categories`, { name: "Pub Root" })).body;
    const sub = (await a.post(`${B}/categories`, { name: "Pub Sub", parentId: root.id })).body;
    const hidden = (await a.post(`${B}/categories`, { name: "Pub Hidden", isActive: false })).body;
    const color = (
      await a.post(`${B}/attributes`, {
        name: "Hue",
        usedForVariants: true,
        values: [{ value: "Red" }, { value: "Blue" }],
      })
    ).body;
    const [red, blue] = color.values;
    const author = (await a.post(`${B}/attributes`, { name: "Writer", values: [{ value: "Ann" }] }))
      .body;

    const live = await mkProduct({
      title: "Live Shirt",
      status: "ACTIVE",
      categoryId: sub.id,
      tags: ["sale"],
      attributeValueIds: [author.values[0].id],
      variants: [
        {
          sku: "LS-R",
          price: "20.00",
          compareAtPrice: "30.00",
          cost: "5.00",
          stock: 3,
          attributeValueIds: [red.id],
        },
        { sku: "LS-B", price: "25.00", cost: "6.00", stock: 0, attributeValueIds: [blue.id] },
      ],
    });
    await mkProduct({ title: "Draft Shirt", status: "DRAFT", price: "1", categoryId: sub.id });
    await mkProduct({
      title: "Archived Shirt",
      status: "ARCHIVED",
      price: "1",
      categoryId: sub.id,
    });
    await mkProduct({
      title: "Future Shirt",
      status: "ACTIVE",
      price: "1",
      categoryId: sub.id,
      publishAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    await mkProduct({
      title: "Expired Shirt",
      status: "ACTIVE",
      price: "1",
      categoryId: sub.id,
      publishAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
      unpublishAt: new Date(Date.now() - 86400_000).toISOString(),
    });
    await mkProduct({
      title: "Soldout Hat",
      status: "ACTIVE",
      price: "500.00",
      sku: "HAT-1",
      stock: 0,
      categoryId: root.id,
    });
    await mkProduct({
      title: "Hidden Cat Item",
      status: "ACTIVE",
      price: "2",
      categoryId: hidden.id,
    });

    const list = await request(app).get("/api/v1/products?pageSize=100");
    expect(list.status).toBe(200);
    const titles = list.body.items.map((i: { title: string }) => i.title);
    expect(titles).toContain("Live Shirt");
    expect(titles).not.toContain("Draft Shirt");
    expect(titles).not.toContain("Archived Shirt");
    expect(titles).not.toContain("Future Shirt");
    expect(titles).not.toContain("Expired Shirt");
    expect(JSON.stringify(list.body)).not.toMatch(/"cost"|onHand|reserved/);

    const item = list.body.items.find((i: { id: string }) => i.id === live.id);
    expect(item).toMatchObject({
      price: "20.00",
      compareAtPrice: "30.00",
      currency: "USD",
      inStock: true,
      category: { name: "Pub Sub", slug: "pub-sub" },
      rating: { average: 0, count: 0 },
    });

    // category tree
    const byRoot = await request(app).get("/api/v1/products?category=pub-root");
    expect(byRoot.body.items.map((i: { title: string }) => i.title).sort()).toEqual([
      "Live Shirt",
      "Soldout Hat",
    ]);
    // price
    const cheap = await request(app).get("/api/v1/products?category=pub-root&maxPrice=100");
    expect(cheap.body.total).toBe(1);
    // attribute (variant-level and product-level)
    expect((await request(app).get("/api/v1/products?attr.hue=blue")).body.total).toBe(1);
    expect((await request(app).get("/api/v1/products?attr.writer=ann")).body.total).toBe(1);
    // tag
    expect((await request(app).get("/api/v1/products?tag=sale")).body.total).toBe(1);
    // inStock excludes sold-out hat
    const inStock = await request(app).get("/api/v1/products?category=pub-root&inStock=true");
    expect(inStock.body.items.map((i: { title: string }) => i.title)).toEqual(["Live Shirt"]);
    // sort
    const sorted = await request(app).get("/api/v1/products?category=pub-root&sort=price_desc");
    expect(sorted.body.items[0].title).toBe("Soldout Hat");
    // pagination bounds
    const big = await request(app).get("/api/v1/products?pageSize=99999&page=-4");
    expect(big.body.pageSize).toBe(100);
    expect(big.body.page).toBe(1);
    const paged = await request(app).get("/api/v1/products?pageSize=1&page=2&sort=title");
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.totalPages).toBe(paged.body.total);
    // search
    const s = await request(app).get("/api/v1/products/search?q=live");
    expect(s.body.items).toHaveLength(1);
    expect((await request(app).get("/api/v1/products/search")).status).toBe(400);

    // detail
    const d = await request(app).get(`/api/v1/products/${live.slug}`);
    expect(d.status).toBe(200);
    expect(JSON.stringify(d.body)).not.toMatch(/"cost"|onHand|reserved/);
    expect(d.body.variants).toHaveLength(2);
    const vr = d.body.variants.find((v: { sku: string }) => v.sku === "LS-R");
    expect(vr).toMatchObject({ price: "20.00", inStock: true, available: 3 });
    expect(vr.attributes[0]).toMatchObject({ attributeSlug: "hue", valueSlug: "red" });
    expect(d.body.variants.find((v: { sku: string }) => v.sku === "LS-B").inStock).toBe(false);
    expect(d.body.attributes[0].valueSlug).toBe("ann");
    expect(d.body.tags[0].slug).toBe("sale");
    expect(Array.isArray(d.body.related)).toBe(true);
    expect((await request(app).get("/api/v1/products/draft-shirt")).status).toBe(404);
    expect((await request(app).get("/api/v1/products/no-such")).status).toBe(404);

    // disabled variants vanish
    await a.patch(`${B}/products/${live.id}/variants/${live.variants[1].id}`, { isActive: false });
    const d2 = await request(app).get(`/api/v1/products/${live.slug}`);
    expect(d2.body.variants).toHaveLength(1);

    // available is capped at 20
    await a.patch(`${B}/inventory/${live.variants[0].id}`, { set: 500, reason: "bulk" });
    const d3 = await request(app).get(`/api/v1/products/${live.slug}`);
    expect(d3.body.variants[0].available).toBe(20);

    // reviews aggregate (approved only)
    await prisma.review.createMany({
      data: [
        { productId: live.id, authorName: "A", rating: 5, status: "APPROVED" },
        { productId: live.id, authorName: "B", rating: 4, status: "APPROVED" },
        { productId: live.id, authorName: "C", rating: 1, status: "PENDING" },
      ],
    });
    const l2 = await request(app).get("/api/v1/products?q=live");
    expect(l2.body.items[0].rating).toEqual({ average: 4.5, count: 2 });
  });

  it("serves category tree, detail with breadcrumb, and hides inactive", async () => {
    const tree = await request(app).get("/api/v1/categories?productCount=true");
    const names = JSON.stringify(tree.body);
    expect(names).toContain("Pub Root");
    expect(names).not.toContain("Pub Hidden");
    const root = tree.body.items.find((c: { slug: string }) => c.slug === "pub-root");
    expect(root.children[0].slug).toBe("pub-sub");
    expect(root.productCount).toBe(2);
    const det = await request(app).get("/api/v1/categories/pub-sub");
    expect(det.body.breadcrumb.map((b: { slug: string }) => b.slug)).toEqual([
      "pub-root",
      "pub-sub",
    ]);
    expect((await request(app).get("/api/v1/categories/pub-root")).body.children[0].slug).toBe(
      "pub-sub",
    );
    expect((await request(app).get("/api/v1/categories/pub-hidden")).status).toBe(404);
  });
});
