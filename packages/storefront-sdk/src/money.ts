/**
 * Format a decimal money string ("1299.50") for display. Money in the API is always a string so
 * no float arithmetic happens server-side; this helper only formats for the UI.
 */
export function formatMoney(
  amount: string | number | null | undefined,
  currency: string,
  locale?: string,
): string {
  if (amount === null || amount === undefined || amount === "") return "";
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** Convert a decimal string to integer minor units (assumes 2 decimals, like the API). */
export function toMinorUnits(amount: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new TypeError(`Invalid money string: ${amount}`);
  const minor = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -minor : minor;
}

/** Inverse of `toMinorUnits`. */
export function fromMinorUnits(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
