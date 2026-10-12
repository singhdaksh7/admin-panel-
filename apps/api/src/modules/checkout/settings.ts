import type { PrismaClient, Tx } from "@kash-commerce/database";
import { AppError, toMinor } from "@kash-commerce/shared";
import type { TaxSettings } from "../tax/engine";

export interface CommerceSettings {
  currency: string;
  tax: TaxSettings & { gstin?: string | null };
  guestCheckout: boolean;
  requirePhone: boolean;
  minOrderMinor: number;
  orderPrefix: string;
  customerAccounts: boolean;
  couponsEnabled: boolean;
}

type Db = PrismaClient | Tx;

/** Reads StoreSettings (singleton) and applies defaults. Works with a client or a transaction. */
export async function loadCommerceSettings(db: Db): Promise<CommerceSettings> {
  const s = await db.storeSettings.findUnique({ where: { id: "store" } });
  const tax = (s?.tax ?? {}) as Record<string, unknown>;
  const checkout = (s?.checkout ?? {}) as Record<string, unknown>;
  const features = (s?.features ?? {}) as Record<string, unknown>;
  const min = typeof checkout.minOrderAmount === "string" ? checkout.minOrderAmount : "0";
  let minOrderMinor = 0;
  try {
    minOrderMinor = toMinor(min || "0");
  } catch {
    minOrderMinor = 0;
  }
  const prefix = String(checkout.orderPrefix ?? "ORD")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 10);
  return {
    currency: s?.currency ?? "USD",
    tax: {
      mode: (tax.mode as string) ?? "NONE",
      defaultRate: typeof tax.defaultRate === "number" ? tax.defaultRate : 0,
      homeState: (tax.homeState as string) ?? null,
      gstin: (tax.gstin as string) ?? null,
      pricesIncludeTax:
        typeof tax.pricesIncludeTax === "boolean" ? tax.pricesIncludeTax : undefined,
    },
    guestCheckout: checkout.guestCheckout !== false && features.guestCheckout !== false,
    requirePhone: checkout.requirePhone === true,
    minOrderMinor,
    orderPrefix: prefix || "ORD",
    customerAccounts: features.customerAccounts !== false,
    couponsEnabled: features.coupons !== false,
  };
}

export async function requireCustomerAccounts(db: Db): Promise<void> {
  const s = await loadCommerceSettings(db);
  if (!s.customerAccounts) throw AppError.forbidden("Customer accounts are disabled");
}
