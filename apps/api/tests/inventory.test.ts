import { beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@kash-commerce/shared";
import { bootApp, createAdminWithRole, loginAdmin, prisma } from "./helpers";
import {
  availableQuantity,
  commitStock,
  releaseStock,
  reserveStock,
  restockItems,
} from "../src/modules/inventory/service";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let a: Awaited<ReturnType<Awaited<ReturnType<typeof bootApp>>["admin"]>>;
const B = "/api/v1/admin";

beforeAll(async () => {
  const boot = await bootApp();
  app = boot.app;
  a = await boot.admin();
});

async function mk(sku: string, stock: number, extra: Record<string, unknown> = {}) {
  const r = await a.post(`${B}/products`, {
    title: `P ${sku}`,
    price: "10.00",
    sku,
    stock,
    ...extra,
  });
  expect(r.status).toBe(201);
  return { productId: r.body.id as string, variantId: r.body.variants[0].id as string };
}

describe("inventory admin API", () => {
  it("adjusts by delta and set, records movements, rejects negatives", async () => {
    const { variantId } = await mk("INV-1", 10);
    const up = await a.patch(`${B}/inventory/${variantId}`, { delta: 5, reason: "Received PO" });
    expect(up.status).toBe(200);
    expect(up.body.onHand).toBe(15);
    expect(
      (await a.patch(`${B}/inventory/${variantId}`, { delta: -3, reason: "Damaged" })).body.onHand,
    ).toBe(12);
    expect(
      (await a.patch(`${B}/inventory/${variantId}`, { set: 7, reason: "Recount" })).body.onHand,
    ).toBe(7);

    // validation: reason required, delta xor set, no negative result
    expect((await a.patch(`${B}/inventory/${variantId}`, { delta: 1 })).status).toBe(422);
    expect(
      (await a.patch(`${B}/inventory/${variantId}`, { delta: 1, set: 2, reason: "x" })).status,
    ).toBe(422);
    expect(
      (await a.patch(`${B}/inventory/${variantId}`, { delta: -8, reason: "too many" })).status,
    ).toBe(422);
    expect((await a.patch(`${B}/inventory/${variantId}`, { delta: 1.5, reason: "x" })).status).toBe(
      422,
    );
    expect((await a.get(`${B}/inventory/${variantId}`)).body.onHand).toBe(7);

    const mv = await a.get(`${B}/inventory/${variantId}/movements`);
    expect(mv.body.items.map((m: { quantity: number }) => m.quantity)).toEqual([-5, -3, 5, 10]);
    expect(mv.body.items[0]).toMatchObject({
      type: "ADJUSTMENT",
      reason: "Recount",
      onHandAfter: 7,
    });
    expect(mv.body.items[0].actorId).toBeTruthy();
  });

  it("allows negative stock only with backorder, and updates settings", async () => {
    const { variantId } = await mk("INV-BO", 1);
    const s = await a.patch(`${B}/inventory/${variantId}`, {
      allowBackorder: true,
      lowStockThreshold: 2,
      reason: "enable backorder",
    });
    expect(s.body).toMatchObject({ allowBackorder: true, lowStockThreshold: 2 });
    expect(
      (await a.patch(`${B}/inventory/${variantId}`, { delta: -3, reason: "oversold" })).body.onHand,
    ).toBe(-2);
  });

  it("lists with search and low-stock filter and report", async () => {
    const low = await mk("LOW-1", 2);
    await mk("LOW-OK", 100);
    const untracked = await mk("LOW-UT", 0);
    await a.patch(`${B}/inventory/${untracked.variantId}`, {
      trackInventory: false,
      reason: "n/a",
    });

    const all = await a.get(`${B}/inventory?q=LOW-`);
    expect(all.body.total).toBe(3);
    const lowList = await a.get(`${B}/inventory?q=LOW-&lowStock=true`);
    expect(lowList.body.items.map((i: { sku: string }) => i.sku)).toEqual(["LOW-1"]);
    const report = await a.get(`${B}/inventory/low-stock`);
    expect(
      report.body.items.some((i: { variantId: string }) => i.variantId === low.variantId),
    ).toBe(true);
    expect(report.body.items.every((i: { isLow: boolean }) => i.isLow)).toBe(true);
    expect((await a.get(`${B}/inventory?pageSize=5000`)).body.pageSize).toBe(100);
  });

  it("enforces permissions", async () => {
    await createAdminWithRole("SUPPORT", "inv-sup@x.example");
    const sup = await loginAdmin(app, "inv-sup@x.example", "Another-Pass-123");
    const { variantId } = await mk("INV-PERM", 3);
    expect((await sup.get(`${B}/inventory`)).status).toBe(200);
    expect((await sup.patch(`${B}/inventory/${variantId}`, { delta: 1, reason: "x" })).status).toBe(
      403,
    );
    await createAdminWithRole("ORDER_MANAGER", "inv-om@x.example");
    const om = await loginAdmin(app, "inv-om@x.example", "Another-Pass-123");
    expect((await om.patch(`${B}/inventory/${variantId}`, { delta: 1, reason: "x" })).status).toBe(
      403,
    );
  });
});

describe("inventory service", () => {
  it("reserve / release / commit / restock lifecycle with movements", async () => {
    const { variantId } = await mk("SVC-1", 10);
    const item = () => prisma.inventoryItem.findUniqueOrThrow({ where: { variantId } });
    await prisma.$transaction((tx) =>
      reserveStock(tx, [{ variantId, quantity: 4 }], { orderId: "o1" }),
    );
    expect(availableQuantity(await item())).toBe(6);
    await prisma.$transaction((tx) =>
      releaseStock(tx, [{ variantId, quantity: 1 }], { orderId: "o1" }),
    );
    expect((await item()).reserved).toBe(3);
    await prisma.$transaction((tx) =>
      commitStock(tx, [{ variantId, quantity: 3 }], { orderId: "o1" }),
    );
    expect(await item()).toMatchObject({ onHand: 7, reserved: 0 });
    await prisma.$transaction((tx) =>
      restockItems(tx, [{ variantId, quantity: 2 }], { orderId: "o1", reason: "RETURN" }),
    );
    expect((await item()).onHand).toBe(9);
    const mv = await prisma.inventoryMovement.findMany({
      where: { orderId: "o1" },
      orderBy: { createdAt: "asc" },
    });
    expect(mv.map((m) => m.type)).toEqual(["RESERVE", "RELEASE", "COMMIT", "RETURN"]);
    expect(mv[0]).toMatchObject({ onHandAfter: 10, reservedAfter: 4 });
    expect(mv[2]).toMatchObject({ onHandAfter: 7, reservedAfter: 0 });
  });

  it("reserve fails atomically with OUT_OF_STOCK naming the variant (whole tx rolls back)", async () => {
    const x = await mk("ATOM-1", 5);
    const y = await mk("ATOM-2", 1);
    const err = await prisma
      .$transaction(async (tx) => {
        await reserveStock(tx, [
          { variantId: x.variantId, quantity: 2 },
          { variantId: y.variantId, quantity: 2 },
        ]);
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("OUT_OF_STOCK");
    expect(err.details).toEqual({ variantId: y.variantId });
    expect(
      (await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: x.variantId } }))
        .reserved,
    ).toBe(0);
  });

  it("backorder and untracked variants can always be reserved", async () => {
    const bo = await mk("RES-BO", 0, { allowBackorder: true });
    const ut = await mk("RES-UT", 0, { trackInventory: false });
    await prisma.$transaction((tx) =>
      reserveStock(tx, [
        { variantId: bo.variantId, quantity: 3 },
        { variantId: ut.variantId, quantity: 3 },
      ]),
    );
    expect(
      (await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: bo.variantId } }))
        .reserved,
    ).toBe(3);
  });

  it("20 parallel reservations against stock of 5 succeed exactly 5 times", async () => {
    const { variantId } = await mk("RACE-1", 5);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        prisma.$transaction((tx) =>
          reserveStock(tx, [{ variantId, quantity: 1 }], { orderId: "race" }),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(5);
    for (const r of results)
      if (r.status === "rejected") expect((r.reason as AppError).code).toBe("OUT_OF_STOCK");
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId } });
    expect(item).toMatchObject({ onHand: 5, reserved: 5 });
    expect(await prisma.inventoryMovement.count({ where: { orderId: "race" } })).toBe(5);
  });
});
