import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, loginAdmin, prisma, request } from "./helpers";
import { addToCart, seedProduct } from "./commerceHelpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
beforeAll(async () => {
  ({ app } = await bootApp());
});

describe("DELETE /cart", () => {
  it("empties items and coupon in one call, only for the caller's own cart", async () => {
    const { variant } = await seedProduct({ price: "10.00", stock: 20 });
    const mine = await addToCart(app, variant.id, 2);
    const theirs = await addToCart(app, variant.id, 1);
    expect(mine).not.toBe(theirs);

    const res = await request(app).delete("/api/v1/cart").set("x-cart-token", mine);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.couponCode ?? null).toBeNull();

    const other = await request(app).get("/api/v1/cart").set("x-cart-token", theirs);
    expect(other.body.itemCount).toBe(1);
  });

  it("404s when there is no cart", async () => {
    const res = await request(app).delete("/api/v1/cart");
    expect(res.status).toBe(404);
  });
});

describe("public store settings", () => {
  it("returns resolved logo/favicon URLs (not just media ids) and null when unset", async () => {
    const before = await request(app).get("/api/v1/store/settings");
    expect(before.body.logoUrl).toBeNull();
    expect(before.body.faviconUrl).toBeNull();

    const key = `${"a".repeat(32)}.png`;
    const media = await prisma.media.create({
      data: {
        storageKey: key,
        provider: "LOCAL",
        filename: "logo.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    });
    const admin = await loginAdmin(app);
    expect((await admin.put("/api/v1/admin/settings", { logoMediaId: media.id })).status).toBe(200);

    const after = await request(app).get("/api/v1/store/settings");
    expect(after.body.logoMediaId).toBe(media.id);
    expect(after.body.logoUrl).toMatch(new RegExp(`/api/v1/media/files/${key}$`));
    expect(after.body.faviconUrl).toBeNull();
  });
});
