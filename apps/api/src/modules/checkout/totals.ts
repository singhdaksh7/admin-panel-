/**
 * Authoritative totals calculation shared by cart (estimate), checkout summary and checkout create.
 * Everything is derived from DB prices; money is integer minor units until the response boundary.
 */
import type { PrismaClient, ShippingMethod, Tx } from "@kash-commerce/database";
import { AppError, fromMinor } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import { assertPurchasable, loadPricedLines, type PricedLine } from "../cart/pricing";
import { couponError, validateCoupon, type CouponValidation } from "../coupons/service";
import {
  computeTax,
  type TaxAddress,
  type TaxBreakdownLine,
  type TaxLineResult,
} from "../tax/engine";
import { resolveShipping } from "../shipping-methods/service";
import { loadCommerceSettings, type CommerceSettings } from "./settings";

type Db = PrismaClient | Tx;

export interface TotalsInput {
  items: Array<{ variantId: string; quantity: number }>;
  couponCode?: string | null;
  address?: TaxAddress;
  shippingMethodCode?: string | null;
  includeShipping: boolean;
  /** strict (checkout): unpurchasable lines / invalid coupon throw. Soft (cart): reported, excluded. */
  strict: boolean;
  customerId?: string | null;
  email?: string | null;
}

export interface TotalsLine extends PricedLine {
  discountMinor: number;
  tax: TaxLineResult;
}

export interface Totals {
  settings: CommerceSettings;
  currency: string;
  lines: TotalsLine[];
  /** lines excluded from totals in soft mode */
  unavailable: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  taxAddedMinor: number;
  taxInclusive: boolean;
  taxBreakdown: TaxBreakdownLine[];
  totalMinor: number;
  coupon: CouponValidation | null;
  couponError: { reason: string; message: string } | null;
  shippingMethod: ShippingMethod | null;
}

export async function computeTotals(ctx: AppContext, db: Db, input: TotalsInput): Promise<Totals> {
  const settings = await loadCommerceSettings(db);
  const all = await loadPricedLines(db, input.items, (k) => ctx.providers.storage.url(k));
  if (input.strict) assertPurchasable(input.items, all);
  const lines = input.strict ? all : all.filter((l) => !l.problems.includes("UNAVAILABLE"));
  const unavailable = all.filter((l) => !lines.includes(l));

  const lineTotals = lines.map((l) => l.unitPriceMinor * l.quantity);
  const subtotalMinor = lineTotals.reduce((a, b) => a + b, 0);

  let coupon: CouponValidation | null = null;
  let couponErr: Totals["couponError"] = null;
  if (input.couponCode) {
    try {
      if (!settings.couponsEnabled) throw couponError("DISABLED");
      coupon = await validateCoupon(db, {
        code: input.couponCode,
        lines: lines.map((l, i) => ({
          productId: l.productId,
          categoryId: l.categoryId,
          lineTotalMinor: lineTotals[i]!,
        })),
        subtotalMinor,
        customerId: input.customerId,
        email: input.email,
      });
    } catch (e) {
      if (input.strict || !(e instanceof AppError)) throw e;
      const d = e.details as { reason?: string } | undefined;
      couponErr = { reason: d?.reason ?? "INVALID", message: e.message };
    }
  }
  const lineDiscounts = coupon?.lineDiscounts ?? lines.map(() => 0);
  const discountMinor = coupon?.discountMinor ?? 0;

  const taxRes = computeTax(
    settings.tax,
    lines.map((l, i) => ({
      key: l.variantId,
      unitPriceMinor: l.unitPriceMinor,
      quantity: l.quantity,
      discountMinor: lineDiscounts[i],
      taxRate: l.taxRate,
      hsnCode: l.hsnCode,
    })),
    input.address ?? {},
  );

  let shippingMinor = 0;
  let shippingMethod: ShippingMethod | null = null;
  if (input.includeShipping) {
    const r = await resolveShipping(db, {
      code: input.shippingMethodCode,
      country: input.address?.country ?? "",
      subtotalMinor: subtotalMinor - discountMinor,
    });
    shippingMinor = r.priceMinor;
    shippingMethod = r.method;
  }

  return {
    settings,
    currency: settings.currency,
    lines: lines.map((l, i) => ({ ...l, discountMinor: lineDiscounts[i]!, tax: taxRes.lines[i]! })),
    unavailable,
    subtotalMinor,
    discountMinor,
    shippingMinor,
    taxMinor: taxRes.taxMinor,
    taxAddedMinor: taxRes.taxAddedMinor,
    taxInclusive: taxRes.inclusive,
    taxBreakdown: taxRes.breakdown,
    totalMinor: subtotalMinor - discountMinor + shippingMinor + taxRes.taxAddedMinor,
    coupon,
    couponError: couponErr,
    shippingMethod,
  };
}

/** JSON projection of totals for API responses (decimal strings). */
export function totalsDto(t: Totals) {
  return {
    currency: t.currency,
    subtotal: fromMinor(t.subtotalMinor),
    discount: fromMinor(t.discountMinor),
    shipping: fromMinor(t.shippingMinor),
    tax: fromMinor(t.taxMinor),
    taxInclusive: t.taxInclusive,
    taxBreakdown: t.taxBreakdown.map((b) => ({
      name: b.name,
      rate: b.rate,
      amount: fromMinor(b.amountMinor),
    })),
    total: fromMinor(t.totalMinor),
    coupon: t.coupon
      ? { code: t.coupon.coupon.code, discount: fromMinor(t.coupon.discountMinor) }
      : null,
    shippingMethod: t.shippingMethod
      ? {
          code: t.shippingMethod.code,
          name: t.shippingMethod.name,
          price: fromMinor(t.shippingMinor),
        }
      : null,
    lines: t.lines.map((l) => ({
      variantId: l.variantId,
      productId: l.productId,
      title: l.productTitle,
      variantTitle: l.variantTitle,
      sku: l.sku,
      imageUrl: l.imageUrl,
      attributes: l.attributes,
      unitPrice: fromMinor(l.unitPriceMinor),
      quantity: l.quantity,
      discount: fromMinor(l.discountMinor),
      taxRate: l.tax.taxRate,
      tax: fromMinor(l.tax.taxMinor),
      lineTotal: fromMinor(l.tax.totalMinor),
    })),
  };
}
