/**
 * Inventory service - the ONLY place that mutates InventoryItem quantities.
 *
 * All functions take a Prisma transaction client (`tx`) so the caller (orders/checkout) can make stock
 * changes atomic with its own writes. Every call writes InventoryMovement rows with onHandAfter/reservedAfter.
 * Quantities are changed with guarded single-statement UPDATEs (no read-then-write), so concurrent callers
 * can never oversell.
 *
 * STABLE SIGNATURES (used by the orders module):
 *   type StockItem = { variantId: string; quantity: number }            // quantity > 0 (integer)
 *   type StockRef  = { orderId?: string | null; actorId?: string | null; reason?: string }
 *
 *   reserveStock(tx, items, ref):  reserved += q  iff (available >= q OR allowBackorder OR !trackInventory)
 *                                  throws AppError.outOfStock (409, details.variantId) for the first failing variant.
 *                                  Items for the same variant are merged; variants are locked in sorted order
 *                                  (deadlock-free). Variants without an InventoryItem row are treated as untracked.
 *   releaseStock(tx, items, ref):  reserved -= q (floored at 0)         -- cancel / payment failure / expiry
 *   commitStock(tx, items, ref):   reserved -= q and onHand -= q        -- order paid/fulfilled (onHand only if tracked)
 *   restockItems(tx, items, ref):  onHand += q                          -- returns/cancellation after commit (RETURN movement
 *                                                                          when ref.reason === "RETURN", else RESTOCK)
 *   availableQuantity(item):       max(0, onHand - reserved)
 *
 * Call these inside `prisma.$transaction(async (tx) => { ... })`.
 */
import { AppError } from "@kash-commerce/shared";
import { Prisma, type InventoryMovementType } from "@kash-commerce/database";

export type StockTx = Prisma.TransactionClient;
export interface StockItem {
  variantId: string;
  quantity: number;
}
export interface StockRef {
  orderId?: string | null;
  actorId?: string | null;
  reason?: string;
}

export function availableQuantity(item: { onHand: number; reserved: number }): number {
  return Math.max(0, item.onHand - item.reserved);
}

interface Row {
  id: string;
  onHand: number;
  reserved: number;
}

function normalize(items: StockItem[]): StockItem[] {
  const merged = new Map<string, number>();
  for (const it of items) {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0)
      throw AppError.badRequest("Quantity must be a positive integer");
    merged.set(it.variantId, (merged.get(it.variantId) ?? 0) + it.quantity);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([variantId, quantity]) => ({ variantId, quantity }));
}

async function movement(
  tx: StockTx,
  row: Row,
  type: InventoryMovementType,
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

export async function reserveStock(tx: StockTx, items: StockItem[], ref: StockRef = {}) {
  for (const { variantId, quantity } of normalize(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem"
         SET "reserved" = "reserved" + ${quantity}, "updatedAt" = now()
       WHERE "variantId" = ${variantId}
         AND ("trackInventory" = false OR "allowBackorder" = true OR "onHand" - "reserved" >= ${quantity})
      RETURNING "id", "onHand", "reserved"`;
    const row = rows[0];
    if (!row) {
      const exists = await tx.inventoryItem.findUnique({
        where: { variantId },
        select: { id: true },
      });
      if (!exists) continue; // no inventory row => untracked
      throw AppError.outOfStock("Insufficient stock", { variantId });
    }
    await movement(tx, row, "RESERVE", quantity, ref);
  }
}

export async function releaseStock(tx: StockTx, items: StockItem[], ref: StockRef = {}) {
  for (const { variantId, quantity } of normalize(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem"
         SET "reserved" = GREATEST("reserved" - ${quantity}, 0), "updatedAt" = now()
       WHERE "variantId" = ${variantId}
      RETURNING "id", "onHand", "reserved"`;
    if (rows[0]) await movement(tx, rows[0], "RELEASE", quantity, ref);
  }
}

export async function commitStock(tx: StockTx, items: StockItem[], ref: StockRef = {}) {
  for (const { variantId, quantity } of normalize(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem"
         SET "reserved" = GREATEST("reserved" - ${quantity}, 0),
             "onHand" = CASE WHEN "trackInventory" THEN "onHand" - ${quantity} ELSE "onHand" END,
             "updatedAt" = now()
       WHERE "variantId" = ${variantId}
      RETURNING "id", "onHand", "reserved"`;
    if (rows[0]) await movement(tx, rows[0], "COMMIT", quantity, ref);
  }
}

export async function restockItems(tx: StockTx, items: StockItem[], ref: StockRef = {}) {
  const type: InventoryMovementType = ref.reason === "RETURN" ? "RETURN" : "RESTOCK";
  for (const { variantId, quantity } of normalize(items)) {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "InventoryItem"
         SET "onHand" = "onHand" + ${quantity}, "updatedAt" = now()
       WHERE "variantId" = ${variantId}
      RETURNING "id", "onHand", "reserved"`;
    if (rows[0]) await movement(tx, rows[0], type, quantity, ref);
  }
}

export interface AdjustInput {
  delta?: number;
  set?: number;
  reason: string;
  actorId?: string | null;
}

/**
 * Admin adjustment. Locks the row (FOR UPDATE) so the delta computation is race-free, never lets onHand
 * go negative (unless allowBackorder). Creates the InventoryItem if the variant has none.
 */
export async function adjustStock(tx: StockTx, variantId: string, input: AdjustInput) {
  await tx.inventoryItem.upsert({
    where: { variantId },
    create: { variantId },
    update: {},
  });
  const [cur] = await tx.$queryRaw<(Row & { allowBackorder: boolean })[]>`
    SELECT "id", "onHand", "reserved", "allowBackorder" FROM "InventoryItem"
     WHERE "variantId" = ${variantId} FOR UPDATE`;
  if (!cur) throw AppError.notFound("Inventory item");
  const delta = input.set !== undefined ? input.set - cur.onHand : (input.delta ?? 0);
  const next = cur.onHand + delta;
  if (next < 0 && !cur.allowBackorder)
    throw AppError.validation("Adjustment would make stock negative", { onHand: cur.onHand });
  const [row] = await tx.$queryRaw<Row[]>`
    UPDATE "InventoryItem" SET "onHand" = ${next}, "updatedAt" = now()
     WHERE "id" = ${cur.id} RETURNING "id", "onHand", "reserved"`;
  await movement(tx, row!, "ADJUSTMENT", delta, {
    reason: input.reason,
    actorId: input.actorId ?? null,
  });
  return row!;
}
