import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@kash-commerce/shared";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const PROVIDER_TIMEOUT_MS = 10_000;

export function hmacHex(data: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Constant-time string comparison; false on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function providerError(provider: string, what: string, status?: number): AppError {
  return new AppError(
    502,
    "PROVIDER_ERROR",
    `${provider} request failed: ${what}`,
    status !== undefined ? { provider, upstreamStatus: status } : { provider },
  );
}

/**
 * Performs a request with a timeout. Returns the parsed JSON body (or null) and status.
 * Never throws raw provider bodies: network/timeout errors become safe AppErrors.
 */
export async function timedFetch(
  fetchFn: FetchLike,
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: ac.signal });
    let body: unknown = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  } catch {
    throw providerError(provider, ac.signal.aborted ? "timeout" : "network error");
  } finally {
    clearTimeout(timer);
  }
}
