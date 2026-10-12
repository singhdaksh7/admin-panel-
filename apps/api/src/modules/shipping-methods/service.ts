import type { PrismaClient, Tx, ShippingMethod } from "@kash-commerce/database";
import { AppError, toMinor } from "@kash-commerce/shared";

type Db = PrismaClient | Tx;

/** Server-side price of a method for a (post-discount) subtotal. PROVIDER_RATE is a flat placeholder. */
export function priceShippingMethod(m: ShippingMethod, subtotalMinor: number): number {
  const price = toMinor(m.price.toString());
  if (
    m.type === "FREE_OVER" &&
    m.freeOverAmount &&
    subtotalMinor >= toMinor(m.freeOverAmount.toString())
  )
    return 0;
  return price;
}

export async function listApplicableMethods(db: Db, country?: string | null) {
  const c = country?.trim().toUpperCase();
  const all = await db.shippingMethod.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return all.filter((m) => m.countries.length === 0 || (c && m.countries.includes(c)));
}

/**
 * Resolve the method for a checkout. No methods defined at all => free/no shipping (null).
 * Otherwise the requested code must be applicable, or the first applicable is used when no code given.
 */
export async function resolveShipping(
  db: Db,
  input: { code?: string | null; country: string; subtotalMinor: number },
): Promise<{ method: ShippingMethod | null; priceMinor: number }> {
  const configured = await db.shippingMethod.count({ where: { isActive: true } });
  if (configured === 0) return { method: null, priceMinor: 0 };
  const applicable = await listApplicableMethods(db, input.country);
  const method = input.code ? applicable.find((m) => m.code === input.code) : applicable[0];
  if (!method)
    throw AppError.validation(
      input.code
        ? "Shipping method is not available for this destination"
        : "No shipping method available for this destination",
    );
  return { method, priceMinor: priceShippingMethod(method, input.subtotalMinor) };
}

export function methodDto(m: ShippingMethod, subtotalMinor?: number) {
  return {
    code: m.code,
    name: m.name,
    type: m.type,
    price: m.price.toFixed(2),
    freeOverAmount: m.freeOverAmount?.toFixed(2) ?? null,
    minDays: m.minDays,
    maxDays: m.maxDays,
    countries: m.countries,
    ...(subtotalMinor !== undefined
      ? { cost: (priceShippingMethod(m, subtotalMinor) / 100).toFixed(2) }
      : {}),
  };
}
