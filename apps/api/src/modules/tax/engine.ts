/**
 * Generic tax engine. PURE (no DB). All math is in integer minor units.
 *
 * Modes (StoreSettings.tax.mode):
 *  - NONE       no tax.
 *  - EXCLUSIVE  prices exclude tax; tax is added on top.
 *  - INCLUSIVE  prices already contain tax; tax is extracted.
 *  - INDIA_GST  CGST+SGST (intra-state, halves) or IGST (inter-state). Prices are tax-inclusive when
 *               `pricesIncludeTax` is true (default, Indian MRP convention), otherwise exclusive.
 *
 * Rates are percentages, taken per line (TaxClass.rate) falling back to `defaultRate`.
 * Shipping is not taxed (documented gap). Discounts must be pre-allocated to lines
 * (see `allocateProportionally`) so that tax is computed on the discounted amount.
 */
import { percentOf } from "@kash-commerce/shared";

export type TaxMode = "NONE" | "EXCLUSIVE" | "INCLUSIVE" | "INDIA_GST";

export interface TaxSettings {
  mode?: TaxMode | string;
  defaultRate?: number | null;
  homeState?: string | null;
  pricesIncludeTax?: boolean;
}

export interface TaxLineInput {
  key: string;
  unitPriceMinor: number;
  quantity: number;
  /** Discount already allocated to this line, minor units. */
  discountMinor?: number;
  /** TaxClass rate in percent; null/undefined => settings.defaultRate. */
  taxRate?: number | null;
  hsnCode?: string | null;
}

export interface TaxLineResult {
  key: string;
  taxRate: number;
  grossMinor: number; // unit * qty (before discount)
  discountMinor: number;
  /** discounted amount excluding tax */
  netMinor: number;
  taxMinor: number;
  /** what the customer pays for the line (net + tax) */
  totalMinor: number;
  hsnCode: string | null;
  components: { cgst: number; sgst: number; igst: number };
}

export interface TaxBreakdownLine {
  name: string; // "Tax" | "CGST" | "SGST" | "IGST"
  rate: number;
  amountMinor: number;
}

export interface TaxResult {
  mode: TaxMode;
  inclusive: boolean;
  lines: TaxLineResult[];
  taxMinor: number;
  /** tax that is ADDED to the payable total (0 when inclusive) */
  taxAddedMinor: number;
  breakdown: TaxBreakdownLine[];
  intraState: boolean | null;
}

export interface TaxAddress {
  state?: string | null;
  country?: string | null;
}

const norm = (s?: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Split `totalMinor` proportionally to `weights` using the largest-remainder method so the parts
 * sum EXACTLY to the total. Each part is capped at its weight (a discount can't exceed a line).
 */
export function allocateProportionally(totalMinor: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = Math.max(0, Math.min(totalMinor, sum));
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const parts = exact.map((e) => Math.floor(e));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    if (parts[i]! < weights[i]!) {
      parts[i]!++;
      remainder--;
    }
  }
  // extremely rare: leftover because of caps; spill to any line with room
  for (let i = 0; remainder > 0 && i < parts.length; i++) {
    const room = weights[i]! - parts[i]!;
    const add = Math.min(room, remainder);
    parts[i]! += add;
    remainder -= add;
  }
  return parts;
}

/** tax extracted from a tax-inclusive amount */
export function extractInclusiveTax(grossMinor: number, ratePercent: number): number {
  if (ratePercent <= 0) return 0;
  return Math.round((grossMinor * ratePercent) / (100 + ratePercent));
}

export function computeTax(
  settings: TaxSettings,
  lines: TaxLineInput[],
  shippingAddress: TaxAddress = {},
): TaxResult {
  const mode = (
    ["NONE", "EXCLUSIVE", "INCLUSIVE", "INDIA_GST"].includes(String(settings.mode))
      ? settings.mode
      : "NONE"
  ) as TaxMode;
  const inclusive =
    mode === "INCLUSIVE" || (mode === "INDIA_GST" && settings.pricesIncludeTax !== false);
  const defaultRate = Number(settings.defaultRate ?? 0) || 0;
  const intraState =
    mode === "INDIA_GST"
      ? !!norm(settings.homeState) && norm(settings.homeState) === norm(shippingAddress.state)
      : null;

  const out: TaxLineResult[] = lines.map((l) => {
    const grossMinor = l.unitPriceMinor * l.quantity;
    const discountMinor = Math.min(Math.max(l.discountMinor ?? 0, 0), grossMinor);
    const afterDiscount = grossMinor - discountMinor;
    const rate = mode === "NONE" ? 0 : Number(l.taxRate ?? defaultRate) || 0;
    let taxMinor = 0;
    if (rate > 0) {
      taxMinor = inclusive
        ? extractInclusiveTax(afterDiscount, rate)
        : percentOf(afterDiscount, rate);
    }
    const components = { cgst: 0, sgst: 0, igst: 0 };
    if (mode === "INDIA_GST" && taxMinor > 0) {
      if (intraState) {
        components.cgst = Math.floor(taxMinor / 2);
        components.sgst = taxMinor - components.cgst;
      } else {
        components.igst = taxMinor;
      }
    }
    return {
      key: l.key,
      taxRate: rate,
      grossMinor,
      discountMinor,
      netMinor: inclusive ? afterDiscount - taxMinor : afterDiscount,
      taxMinor,
      totalMinor: inclusive ? afterDiscount : afterDiscount + taxMinor,
      hsnCode: l.hsnCode ?? null,
      components,
    };
  });

  const taxMinor = out.reduce((a, l) => a + l.taxMinor, 0);

  // breakdown grouped by (name, rate)
  const groups = new Map<string, TaxBreakdownLine>();
  const add = (name: string, rate: number, amount: number) => {
    if (amount <= 0) return;
    const k = `${name}@${rate}`;
    const g = groups.get(k);
    if (g) g.amountMinor += amount;
    else groups.set(k, { name, rate, amountMinor: amount });
  };
  for (const l of out) {
    if (mode === "INDIA_GST") {
      if (intraState) {
        add("CGST", l.taxRate / 2, l.components.cgst);
        add("SGST", l.taxRate / 2, l.components.sgst);
      } else add("IGST", l.taxRate, l.components.igst);
    } else add("Tax", l.taxRate, l.taxMinor);
  }

  return {
    mode,
    inclusive,
    lines: out,
    taxMinor,
    taxAddedMinor: inclusive ? 0 : taxMinor,
    breakdown: [...groups.values()],
    intraState,
  };
}
