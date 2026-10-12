/** Store settings form model: API row <-> editable state, per-tab diff payloads, validation. */

export type TabKey = "general" | "locale" | "tax" | "checkout" | "features" | "social";

export const FEATURE_FLAGS = [
  ["customerAccounts", "Customer accounts"],
  ["guestCheckout", "Guest checkout"],
  ["reviews", "Product reviews"],
  ["blog", "Blog"],
  ["coupons", "Coupons"],
  ["inventory", "Inventory tracking"],
] as const;
export const SOCIAL_KEYS = [
  "facebook",
  "instagram",
  "twitter",
  "youtube",
  "linkedin",
  "pinterest",
  "tiktok",
] as const;
export const TAX_MODES = ["NONE", "EXCLUSIVE", "INCLUSIVE", "INDIA_GST"] as const;

export interface SettingsState {
  name: string;
  legalName: string;
  logoMediaId: string | null;
  faviconMediaId: string | null;
  supportEmail: string;
  phone: string;
  address: Record<"line1" | "line2" | "city" | "state" | "postalCode" | "country", string>;
  currency: string;
  locale: string;
  timezone: string;
  tax: { mode: string; defaultRate: string; gstin: string; homeState: string };
  checkout: {
    guestCheckout: boolean;
    requirePhone: boolean;
    minOrderAmount: string;
    orderPrefix: string;
    invoicePrefix: string;
    returnWindowDays: string;
  };
  features: Record<(typeof FEATURE_FLAGS)[number][0], boolean>;
  social: Record<string, string>;
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function toState(row: Raw): SettingsState {
  const a = (row.address ?? {}) as Raw;
  const t = (row.tax ?? {}) as Raw;
  const c = (row.checkout ?? {}) as Raw;
  const f = (row.features ?? {}) as Raw;
  const s = (row.social ?? {}) as Raw;
  return {
    name: str(row.name),
    legalName: str(row.legalName),
    logoMediaId: (row.logoMediaId as string | null) ?? null,
    faviconMediaId: (row.faviconMediaId as string | null) ?? null,
    supportEmail: str(row.supportEmail),
    phone: str(row.phone),
    address: {
      line1: str(a.line1),
      line2: str(a.line2),
      city: str(a.city),
      state: str(a.state),
      postalCode: str(a.postalCode),
      country: str(a.country),
    },
    currency: str(row.currency),
    locale: str(row.locale),
    timezone: str(row.timezone),
    tax: {
      mode: str(t.mode) || "NONE",
      defaultRate: t.defaultRate === undefined ? "" : str(t.defaultRate),
      gstin: str(t.gstin),
      homeState: str(t.homeState),
    },
    checkout: {
      guestCheckout: c.guestCheckout !== false,
      requirePhone: c.requirePhone === true,
      minOrderAmount: str(c.minOrderAmount),
      orderPrefix: str(c.orderPrefix),
      invoicePrefix: str(c.invoicePrefix),
      returnWindowDays: c.returnWindowDays === undefined ? "" : str(c.returnWindowDays),
    },
    features: Object.fromEntries(
      FEATURE_FLAGS.map(([k]) => [k, f[k] !== false]),
    ) as SettingsState["features"],
    social: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, str(v)])),
  };
}

const nullable = (s: string) => (s.trim() ? s.trim() : null);

/** Fields of one tab that differ from the baseline, in API shape. Empty object => nothing changed. */
export function buildPayload(tab: TabKey, base: SettingsState, cur: SettingsState): Raw {
  const out: Raw = {};
  const diffScalar = <K extends keyof SettingsState>(
    k: K,
    conv: (v: SettingsState[K]) => unknown,
  ) => {
    if (JSON.stringify(base[k]) !== JSON.stringify(cur[k])) out[k] = conv(cur[k]);
  };
  const diffObj = <T extends Record<string, unknown>>(
    a: T,
    b: T,
    conv: (k: keyof T, v: T[keyof T]) => unknown,
    skipEmpty: (k: keyof T, v: T[keyof T]) => boolean = () => false,
  ) => {
    const o: Raw = {};
    for (const k of Object.keys(b) as (keyof T)[]) {
      if (a[k] !== b[k] && !skipEmpty(k, b[k])) o[k as string] = conv(k, b[k]);
    }
    return o;
  };

  if (tab === "general") {
    diffScalar("name", (v) => v.trim());
    diffScalar("legalName", (v) => nullable(v));
    diffScalar("logoMediaId", (v) => v);
    diffScalar("faviconMediaId", (v) => v);
    diffScalar("supportEmail", (v) => nullable(v));
    diffScalar("phone", (v) => nullable(v));
    const addr = diffObj(
      base.address,
      cur.address,
      (_k, v) => (v as string).trim(),
      (k, v) => k === "country" && !(v as string).trim(),
    );
    if (Object.keys(addr).length) out.address = addr;
  }
  if (tab === "locale") {
    diffScalar("currency", (v) => v.trim().toUpperCase());
    diffScalar("locale", (v) => v.trim());
    diffScalar("timezone", (v) => v.trim());
  }
  if (tab === "tax") {
    const t = diffObj(
      base.tax,
      cur.tax,
      (k, v) => (k === "defaultRate" ? Number(v) : (v as string).trim()),
      (k, v) => k === "defaultRate" && v === "",
    );
    if (Object.keys(t).length) out.tax = t;
  }
  if (tab === "checkout") {
    const c = diffObj(
      base.checkout,
      cur.checkout,
      (k, v) => (k === "returnWindowDays" ? Number(v) : typeof v === "string" ? v.trim() : v),
      (k, v) => (k === "returnWindowDays" || k === "minOrderAmount") && v === "",
    );
    if (Object.keys(c).length) out.checkout = c;
  }
  if (tab === "features") {
    const f = diffObj(base.features, cur.features, (_k, v) => v);
    if (Object.keys(f).length) out.features = f;
  }
  if (tab === "social") {
    if (JSON.stringify(base.social) !== JSON.stringify(cur.social)) {
      out.social = Object.fromEntries(
        Object.entries(cur.social)
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([, v]) => v),
      );
    }
  }
  return out;
}

export function isTabDirty(tab: TabKey, base: SettingsState, cur: SettingsState): boolean {
  return Object.keys(buildPayload(tab, base, cur)).length > 0;
}

export function validateTab(tab: TabKey, s: SettingsState): Record<string, string> {
  const e: Record<string, string> = {};
  if (tab === "general") {
    if (!s.name.trim()) e.name = "Store name is required";
    if (s.supportEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.supportEmail.trim()))
      e.supportEmail = "Enter a valid email address";
    if (s.address.country.trim() && s.address.country.trim().length !== 2)
      e["address.country"] = "Use a 2-letter country code (e.g. IN)";
  }
  if (tab === "locale") {
    if (!/^[A-Za-z]{3}$/.test(s.currency.trim())) e.currency = "Use a 3-letter ISO code (e.g. USD)";
    if (s.locale.trim().length < 2) e.locale = "Enter a locale such as en-US";
    if (!s.timezone.trim()) e.timezone = "Timezone is required";
    else {
      try {
        new Intl.DateTimeFormat("en", { timeZone: s.timezone.trim() });
      } catch {
        e.timezone = "Unknown timezone (use an IANA name like Asia/Kolkata)";
      }
    }
  }
  if (tab === "tax") {
    if (s.tax.defaultRate !== "") {
      const r = Number(s.tax.defaultRate);
      if (Number.isNaN(r) || r < 0 || r > 100) e["tax.defaultRate"] = "Between 0 and 100";
    }
    if (
      s.tax.mode === "INDIA_GST" &&
      s.tax.gstin.trim() &&
      !/^[0-9A-Za-z]{15}$/.test(s.tax.gstin.trim())
    )
      e["tax.gstin"] = "GSTIN must be 15 characters";
  }
  if (tab === "checkout") {
    if (s.checkout.minOrderAmount && !/^\d+(\.\d{1,2})?$/.test(s.checkout.minOrderAmount))
      e["checkout.minOrderAmount"] = "Use a decimal like 25.00";
    if (s.checkout.returnWindowDays !== "") {
      const d = Number(s.checkout.returnWindowDays);
      if (!Number.isInteger(d) || d < 0 || d > 365)
        e["checkout.returnWindowDays"] = "0 to 365 days";
    }
    if (s.checkout.orderPrefix && !/^[A-Za-z0-9]{1,10}$/.test(s.checkout.orderPrefix))
      e["checkout.orderPrefix"] = "Up to 10 letters or digits";
    if (s.checkout.invoicePrefix && !/^[A-Za-z0-9-]{1,10}$/.test(s.checkout.invoicePrefix))
      e["checkout.invoicePrefix"] = "Up to 10 letters, digits or -";
  }
  if (tab === "social") {
    for (const [k, v] of Object.entries(s.social)) {
      if (!v.trim()) continue;
      try {
        const u = new URL(v.trim());
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        e[`social.${k}`] = "Enter a full URL starting with https://";
      }
    }
  }
  return e;
}
