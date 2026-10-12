import { beforeAll, describe, expect, it } from "vitest";
import {
  bootApp,
  createAdminWithRole,
  loginAdmin,
  prisma,
  request,
  type AdminSessionHandle,
} from "./helpers";
import { mkProduct } from "./contentFixtures";
import { getRatingAggregates } from "../src/modules/reviews/service";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: AdminSessionHandle;
let productId: string;

beforeAll(async () => {
  const b = await bootApp();
  app = b.app;
  admin = await b.admin();
  productId = (await mkProduct({ slug: "tee" })).id;
  await mkProduct({ slug: "draft-tee", status: "DRAFT" });
});

const post = (slug: string, body: object) =>
  request(app).post(`/api/v1/products/${slug}/reviews`).send(body);
const valid = (over: object = {}) => ({
  rating: 5,
  title: "Great",
  body: "Loved it",
  authorName: "Ann",
  email: "ann@x.example",
  ...over,
});

describe("submission", () => {
  it("creates PENDING reviews that are hidden publicly", async () => {
    const r = await post("tee", valid());
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("PENDING");
    const list = await request(app).get("/api/v1/products/tee/reviews");
    expect(list.body.items).toEqual([]);
    expect(list.body.aggregate).toMatchObject({ count: 0, average: 0 });
  });

  it.each([
    [{ rating: 0 }],
    [{ rating: 6 }],
    [{ rating: 3.5 }],
    [{ body: "" }],
    [{ body: "x".repeat(3001) }],
    [{ title: "x".repeat(121) }],
    [{ authorName: "" }],
    [{ email: "nope" }],
  ])("rejects invalid input %j", async (over) => {
    expect(
      (
        await post(
          "tee",
          valid({ ...over, email: (over as { email?: string }).email ?? "v@x.example" }),
        )
      ).status,
    ).toBe(422);
  });

  it("strips HTML from text fields", async () => {
    const r = await post(
      "tee",
      valid({
        email: "h@x.example",
        authorName: "<b>Bob</b>",
        title: "<script>x</script>Nice",
        body: "Hi <img src=x onerror=alert(1)> there &amp; co",
      }),
    );
    expect(r.status).toBe(201);
    const row = await prisma.review.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row.authorName).toBe("Bob");
    expect(row.title).toBe("Nice");
    expect(row.body).toBe("Hi  there & co");
  });

  it("prevents duplicate reviews per email+product (case-insensitive) until deleted", async () => {
    expect((await post("tee", valid({ email: "dup@x.example" }))).status).toBe(201);
    expect((await post("tee", valid({ email: "DUP@x.example" }))).status).toBe(409);
    const row = await prisma.review.findFirstOrThrow({ where: { authorEmail: "dup@x.example" } });
    expect((await admin.del(`/api/v1/admin/reviews/${row.id}`)).status).toBe(204);
    expect((await post("tee", valid({ email: "dup@x.example" }))).status).toBe(201);
  });

  it("404 for drafts/unknown products and when the reviews feature is off", async () => {
    expect((await post("draft-tee", valid({ email: "d@x.example" }))).status).toBe(404);
    expect((await post("nope", valid({ email: "d@x.example" }))).status).toBe(404);
    expect((await request(app).get("/api/v1/products/draft-tee/reviews")).status).toBe(404);
    await prisma.storeSettings.upsert({
      where: { id: "store" },
      create: { id: "store", features: { reviews: false } },
      update: { features: { reviews: false } },
    });
    expect((await post("tee", valid({ email: "off@x.example" }))).status).toBe(404);
    await prisma.storeSettings.update({ where: { id: "store" }, data: { features: {} } });
  });

  it("marks verifiedPurchase only for non-cancelled orders containing the product", async () => {
    const mk = async (
      email: string,
      status: "CONFIRMED" | "CANCELLED" | "PENDING",
      pid: string | null,
      n: string,
    ) =>
      prisma.order.create({
        data: {
          orderNumber: n,
          status,
          email,
          currency: "USD",
          subtotal: "10",
          total: "10",
          customerSnapshot: {},
          shippingAddress: {},
          billingAddress: {},
          items: {
            create: {
              productId: pid,
              productTitle: "Tee",
              sku: "s",
              unitPrice: "10",
              quantity: 1,
              lineTotal: "10",
            },
          },
        },
      });
    const other = (await mkProduct({ slug: "other" })).id;
    await mk("buyer@x.example", "PENDING", productId, "O-1");
    await mk("cancel@x.example", "CANCELLED", productId, "O-2");
    await mk("wrong@x.example", "PENDING", other, "O-3");
    const a = await post("tee", valid({ email: "Buyer@X.example" }));
    const b = await post("tee", valid({ email: "cancel@x.example" }));
    const c = await post("tee", valid({ email: "wrong@x.example" }));
    expect(a.body.verifiedPurchase).toBe(true);
    expect(b.body.verifiedPurchase).toBe(false);
    expect(c.body.verifiedPurchase).toBe(false);
  });
});

describe("moderation, aggregates and listing", () => {
  it("approve flow publishes the review, computes aggregates, never leaks email", async () => {
    await prisma.review.deleteMany({});
    const ids: string[] = [];
    for (const [i, rating] of [5, 4, 4, 1].entries()) {
      const r = await post(
        "tee",
        valid({ rating, email: `u${i}@x.example`, authorName: `U${i}`, body: `body ${i}` }),
      );
      ids.push(r.body.id);
    }
    expect((await request(app).get("/api/v1/products/tee/reviews")).body.items).toHaveLength(0);
    const ok = await admin.patch(`/api/v1/admin/reviews/${ids[0]}/moderate`, {
      status: "APPROVED",
      moderationNote: "ok",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.moderatedAt).toBeTruthy();
    await admin.patch(`/api/v1/admin/reviews/${ids[1]}/moderate`, { status: "APPROVED" });
    await admin.patch(`/api/v1/admin/reviews/${ids[2]}/moderate`, { status: "APPROVED" });
    await admin.patch(`/api/v1/admin/reviews/${ids[3]}/moderate`, {
      status: "REJECTED",
      moderationNote: "spam",
    });

    const pub = await request(app).get("/api/v1/products/tee/reviews");
    expect(pub.body.items).toHaveLength(3);
    expect(pub.body.aggregate).toEqual({
      average: 4.3,
      count: 3,
      distribution: { "1": 0, "2": 0, "3": 0, "4": 2, "5": 1 },
    });
    expect(JSON.stringify(pub.body)).not.toMatch(/@x\.example|authorEmail|moderationNote/);
    const hi = await request(app).get("/api/v1/products/tee/reviews?sort=highest&pageSize=2");
    expect(hi.body.items.map((r: { rating: number }) => r.rating)).toEqual([5, 4]);
    expect(hi.body.total).toBe(3);
    const lo = await request(app).get("/api/v1/products/tee/reviews?sort=lowest");
    expect(lo.body.items[0].rating).toBe(4);

    const map = await getRatingAggregates(prisma, [productId, "missing"]);
    expect(map.get(productId)!.count).toBe(3);
    expect(map.get("missing")).toMatchObject({ count: 0, average: 0 });
    expect((await getRatingAggregates(prisma, [])).size).toBe(0);
  });

  it("admin list filters by status/search; bulk moderate; delete; 404s", async () => {
    await prisma.review.deleteMany({});
    const ids: string[] = [];
    for (const n of ["alpha", "beta", "gamma"]) {
      ids.push(
        (await post("tee", valid({ email: `${n}@x.example`, authorName: n, body: `review ${n}` })))
          .body.id,
      );
    }
    const pending = await admin.get("/api/v1/admin/reviews?status=PENDING");
    expect(pending.body.total).toBe(3);
    expect(pending.body.items[0].product.slug).toBe("tee");
    expect((await admin.get("/api/v1/admin/reviews?q=beta")).body.total).toBe(1);
    const bulk = await admin.post("/api/v1/admin/reviews/bulk", {
      ids: ids.slice(0, 2),
      action: "approve",
    });
    expect(bulk.body.affected).toBe(2);
    expect((await admin.get("/api/v1/admin/reviews?status=APPROVED")).body.total).toBe(2);
    await admin.post("/api/v1/admin/reviews/bulk", {
      ids: [ids[0]],
      action: "reject",
      moderationNote: "no",
    });
    expect(
      (await admin.get("/api/v1/admin/reviews?status=REJECTED")).body.items[0].moderationNote,
    ).toBe("no");
    expect(
      (await admin.post("/api/v1/admin/reviews/bulk", { ids: [ids[2]], action: "delete" })).body
        .affected,
    ).toBe(1);
    expect(
      (await admin.patch("/api/v1/admin/reviews/nope/moderate", { status: "APPROVED" })).status,
    ).toBe(404);
    expect(
      (await admin.patch(`/api/v1/admin/reviews/${ids[0]}/moderate`, { status: "BOGUS" })).status,
    ).toBe(422);
  });
});

describe("permissions", () => {
  it("SUPPORT and CONTENT_MANAGER moderate; CATALOG_MANAGER only reads; anonymous blocked", async () => {
    const r = await post("tee", valid({ email: "perm@x.example" }));
    await createAdminWithRole("SUPPORT", "sup@x.example");
    await createAdminWithRole("CONTENT_MANAGER", "cm@x.example");
    await createAdminWithRole("CATALOG_MANAGER", "cat@x.example");
    await createAdminWithRole("ORDER_MANAGER", "ord@x.example");
    const sup = await loginAdmin(app, "sup@x.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm@x.example", "Another-Pass-123");
    const cat = await loginAdmin(app, "cat@x.example", "Another-Pass-123");
    const ord = await loginAdmin(app, "ord@x.example", "Another-Pass-123");
    const mod = { status: "APPROVED" };
    expect((await sup.patch(`/api/v1/admin/reviews/${r.body.id}/moderate`, mod)).status).toBe(200);
    expect((await cm.patch(`/api/v1/admin/reviews/${r.body.id}/moderate`, mod)).status).toBe(200);
    expect((await cat.get("/api/v1/admin/reviews")).status).toBe(200);
    expect((await cat.patch(`/api/v1/admin/reviews/${r.body.id}/moderate`, mod)).status).toBe(403);
    expect((await cat.del(`/api/v1/admin/reviews/${r.body.id}`)).status).toBe(403);
    expect((await ord.get("/api/v1/admin/reviews")).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/reviews")).status).toBe(401);
  });
});
