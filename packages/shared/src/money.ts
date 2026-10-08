/**
 * Money helpers operate on integer minor units internally to avoid float drift.
 * API/DB boundary uses decimal strings ("12.50"). Assumes 2 minor digits.
 */
export function toMinor(amount: string | number | { toString(): string }): number {
  const s = amount.toString().trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid money value: ${s}`);
  const neg = s.startsWith("-");
  const [i = "0", f = ""] = s.replace("-", "").split(".");
  const v = parseInt(i, 10) * 100 + parseInt((f + "00").slice(0, 2), 10);
  return neg ? -v : v;
}

export function fromMinor(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/** percent may have decimals (e.g. 18 or 2.5). Rounds half-up to the minor unit. */
export function percentOf(minor: number, percent: number): number {
  return Math.round((minor * percent) / 100);
}
