import { describe, expect, it } from "vitest";
import { CommerceError, isCommerceError } from "../src";
import { apiError, json, setup } from "./helpers";

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as CommerceError;
  }
  throw new Error("expected rejection");
};

describe("error mapping", () => {
  it("maps the API error envelope onto CommerceError", async () => {
    const { commerce } = setup(() =>
      apiError(
        422,
        "VALIDATION_ERROR",
        "Invalid request",
        { details: [{ path: "email", message: "Invalid email" }], requestId: "req-1" },
        { "x-request-id": "hdr-1" },
      ),
    );
    const e = await fail(commerce.auth.register({ email: "x", password: "y" }));
    expect(isCommerceError(e)).toBe(true);
    expect(e).toBeInstanceOf(CommerceError);
    expect(e.status).toBe(422);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.message).toBe("Invalid request");
    expect(e.requestId).toBe("req-1");
    expect(e.isValidation()).toBe(true);
    expect(e.fieldErrors()).toEqual([{ path: "email", message: "Invalid email" }]);
  });

  it("falls back to the x-request-id header when the body has none", async () => {
    const { commerce } = setup(() =>
      apiError(404, "NOT_FOUND", "x", {}, { "x-request-id": "h-9" }),
    );
    const e = await fail(commerce.products.getBySlug("nope"));
    expect(e.requestId).toBe("h-9");
    expect(e.isNotFound()).toBe(true);
  });

  it("exposes out-of-stock details", async () => {
    const { commerce } = setup(() =>
      apiError(409, "OUT_OF_STOCK", "Only 2 available", { details: { available: 2 } }),
    );
    const e = await fail(commerce.cart.add({ variantId: "v", quantity: 5 }));
    expect(e.isOutOfStock()).toBe(true);
    expect(e.details).toEqual({ available: 2 });
    expect(e.isRetryable).toBe(false);
  });

  it("handles non-JSON error bodies (proxy HTML pages)", async () => {
    const { commerce } = setup(
      () => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      { retry: false },
    );
    const e = await fail(commerce.store.getSettings());
    expect(e.status).toBe(502);
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(e.message).toBe("Bad Gateway");
    expect(e.isRetryable).toBe(true);
    expect(e.details).toEqual({ body: "<html>Bad gateway</html>" });
  });

  it("handles empty error bodies and maps status to a code", async () => {
    const { commerce } = setup(() => new Response(null, { status: 429 }), { retry: false });
    const e = await fail(commerce.store.getSettings());
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.isRateLimited()).toBe(true);
    expect(e.message).toBe("HTTP 429");
  });

  it("rejects a 200 response that is not JSON", async () => {
    const { commerce } = setup(() => new Response("OK", { status: 200 }));
    const e = await fail(commerce.store.getSettings());
    expect(e.code).toBe("INVALID_RESPONSE");
  });

  it("normalises network failures", async () => {
    const { commerce } = setup(
      () => {
        throw new TypeError("fetch failed");
      },
      { retry: false },
    );
    const e = await fail(commerce.store.getSettings());
    expect(e.code).toBe("NETWORK_ERROR");
    expect(e.status).toBe(0);
    expect(e.isNetworkError()).toBe(true);
    expect((e.cause as Error).message).toBe("fetch failed");
  });

  it("times out hung requests with code TIMEOUT", async () => {
    const { commerce } = setup(() => new Promise<Response>(() => undefined), {
      timeoutMs: 25,
      retry: false,
    });
    const e = await fail(commerce.store.getSettings());
    expect(e.code).toBe("TIMEOUT");
    expect(e.isRetryable).toBe(true);
  });

  it("passes an AbortSignal to fetch and maps user aborts to ABORTED", async () => {
    const ctrl = new AbortController();
    const { commerce } = setup(
      (c) =>
        new Promise<Response>((_, reject) => {
          c.init.signal!.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
      { timeoutMs: 5000 },
    );
    const p = fail(commerce.store.getSettings({ signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 10);
    const e = await p;
    expect(e.code).toBe("ABORTED");
  });

  it("JSON-serialises errors for logging", async () => {
    const { commerce } = setup(() => apiError(403, "FORBIDDEN", "no", { requestId: "r" }));
    const e = await fail(commerce.store.getSettings());
    expect(JSON.parse(JSON.stringify(e))).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("returns undefined for 204 responses", async () => {
    const { commerce } = setup(() => new Response(null, { status: 204 }));
    await expect(commerce.account.addresses.remove("a")).resolves.toBeUndefined();
  });
});

describe("retry policy", () => {
  it("retries idempotent GETs on 5xx and returns the eventual success", async () => {
    const { commerce, calls } = setup((_, n) =>
      n < 3 ? apiError(503, "INTERNAL_ERROR", "down") : json({ name: "ok" }),
    );
    await expect(commerce.store.getSettings()).resolves.toEqual({ name: "ok" });
    expect(calls).toHaveLength(3);
  });

  it("retries GETs on 429 honouring Retry-After and on network errors", async () => {
    let n = 0;
    const { commerce, calls } = setup(() => {
      n++;
      if (n === 1) return apiError(429, "RATE_LIMITED", "slow", {}, { "retry-after": "0" });
      if (n === 2) throw new TypeError("reset");
      return json({ ok: 1 });
    });
    await commerce.store.getSettings();
    expect(calls).toHaveLength(3);
  });

  it("gives up after the configured number of retries", async () => {
    const { commerce, calls } = setup(() => apiError(500, "INTERNAL_ERROR", "boom"), {
      retry: { retries: 1, baseDelayMs: 0 },
    });
    const e = await fail(commerce.store.getSettings());
    expect(e.status).toBe(500);
    expect(calls).toHaveLength(2);
  });

  it("does not retry 4xx", async () => {
    const { commerce, calls } = setup(() => apiError(404, "NOT_FOUND"));
    await fail(commerce.products.getBySlug("x"));
    expect(calls).toHaveLength(1);
  });

  it("NEVER retries POST, even on 503 or network errors", async () => {
    const a = setup(() => apiError(503, "INTERNAL_ERROR"));
    await fail(a.commerce.cart.add({ variantId: "v" }));
    expect(a.calls).toHaveLength(1);
    const b = setup(() => {
      throw new TypeError("net");
    });
    await fail(b.commerce.checkout.create({ shippingAddress: addr }));
    expect(b.calls).toHaveLength(1);
    const c = setup(() => apiError(429, "RATE_LIMITED"));
    await fail(c.commerce.payments.retry({ orderNumber: "1", email: "a@b.co" }));
    expect(c.calls).toHaveLength(1);
  });

  it("retry: false disables retries entirely", async () => {
    const { commerce, calls } = setup(() => apiError(503, "INTERNAL_ERROR"), { retry: false });
    await fail(commerce.store.getSettings());
    expect(calls).toHaveLength(1);
  });
});

const addr = {
  fullName: "A",
  line1: "1 St",
  city: "C",
  postalCode: "1",
  country: "US",
};
