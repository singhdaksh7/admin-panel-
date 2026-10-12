/**
 * Thin inventory adapter used by checkout/orders. Same four-function contract as the catalog
 * agent's inventory service so the coordinator can swap the import:
 *
 *   reserveStock(tx, items, ref)   reserved += q   (guarded: onHand - reserved >= q unless backorder)
 *   releaseStock(tx, items, ref)   reserved -= q   (cancel before commit)
 *   commitStock(tx, items, ref)    onHand -= q, reserved -= q   (order confirmed)
 *   restockItems(tx, items, ref)   onHand += q     (cancel/return after commit)
 *
 * Items whose InventoryItem is missing or has trackInventory=false are ignored by all four.
 * Every change writes an InventoryMovement. Items are processed sorted by variantId (deadlock-safe).
 */
import type { Tx } from "@kash-commerce/database";
import { AppError } from "@kash-commerce/shared";

export interface StockItem {
  variantId: string;
  quantity: number;
}
export interface StockRef {
  orderId?: string | null;
  reason?: string;
  actorId?: string | null;
}

interface Row {
  id: string;
  onHand: number;
  reserved: number;
}

function merge(items: StockItem[]): StockItem[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.variantId, (m.get(i.variantId) ?? 0) + i.quantity);
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([variantId, quantity]) => ({ variantId, quantity }));
}

async function movement(
  tx: Tx,
  row: Row,
  type: "RESERVE" | "RELEASE" | "COMMIT" | "RESTOCK",
  quantity: number,
  ref: StockRef,
) {
  await tx.inventoryMovement.create({
    data: {
      itemId: row.id,
      type,
      quantity,
      reason: ref.reason ?? null,
      orderId: ref.orderId ?? null,
      actorId: ref.actorId ?? null,
      onHandAfter: row.onHand,
      reservedAfter: row.reserved,
    },
  });
}

export async function reserveStock(tx: Tx, items: StockItem[], ref: StockRef = {}): Promise<void> {
  for (const { variantId, quantity } of merge(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem" SET "reserved" = "reserved" + ${quantity}, "updatedAt" = now()
      WHERE "variantId" = ${variantId} AND "trackInventory"
        AND ("allowBackorder" OR "onHand" - "reserved" >= ${quantity})
      RETURNING "id", "onHand", "reserved"`;
    if (rows[0]) {
      await movement(tx, rows[0], "RESERVE", quantity, ref);
      continue;
    }
    const item = await tx.inventoryItem.findUnique({ where: { variantId } });
    if (item && item.trackInventory) {
      throw AppError.outOfStock("Insufficient stock", {
        variantId,
        requested: quantity,
        available: Math.max(0, item.onHand - item.reserved),
      });
    }
    // untracked / no inventory row => unlimited
  }
}

export async function releaseStock(tx: Tx, items: StockItem[], ref: StockRef = {}): Promise<void> {
  for (const { variantId, quantity } of merge(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem" SET "reserved" = GREATEST("reserved" - ${quantity}, 0), "updatedAt" = now()
      WHERE "variantId" = ${variantId} AND "trackInventory"
      RETURNING "id", "onHand", "reserved"`;
    if (rows[0]) await movement(tx, rows[0], "RELEASE", quantity, ref);
  }
}

export async function commitStock(tx: Tx, items: StockItem[], ref: StockRef = {}): Promise<void> {
  for (const { variantId, quantity } of merge(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem"
      SET "onHand" = "onHand" - ${quantity}, "reserved" = GREATEST("reserved" - ${quantity}, 0),
          "updatedAt" = now()
      WHERE "variantId" = ${variantId} AND "trackInventory"
      RETURNING "id", "onHand", "reserved"`;
    if (rows[0]) await movement(tx, rows[0], "COMMIT", quantity, ref);
  }
}

export async function restockItems(tx: Tx, items: StockItem[], ref: StockRef = {}): Promise<void> {
  for (const { variantId, quantity } of merge(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem" SET "onHand" = "onHand" + ${quantity}, "updatedAt" = now()
      WHERE "variantId" = ${variantId} AND "trackInventory"
      RETURNING "id", "onHand", "reserved"`;
    if (rows[0]) await movement(tx, rows[0], "RESTOCK", quantity, ref);
  }
}
