import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@kash-commerce/shared";
import { ManualPaymentProvider } from "../../src/providers/payment/manual";
import { MockPaymentProvider, signMockPayment } from "../../src/providers/payment/mock";
import { RazorpayProvider } from "../../src/providers/payment/razorpay";
import { CashfreeProvider } from "../../src/providers/payment/cashfree";

const hmac = (d: string | Buffer, k: string) => createHmac("sha256", k).update(d).digest("hex");

const KEY_ID = "rzp_test_keyid";
const KEY_SECRET = "super-secret-key-value";
const WH_SECRET = "whsec-value-123";

function fakeFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), { status });
  });
  return fn;
}

function rzp(f: ReturnType<typeof fakeFetch>) {
  return new RazorpayProvider({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: WH_SECRET,
    fetch: f,
    displayName: "Shop",
  });
}

describe("MockPaymentProvider", () => {
  const p = new MockPaymentProvider();

  it("creates deterministic orders", async () => {
    const r = await p.createPayment({
      orderId: "o1",
      orderNumber: "N1",
      amount: "10.00",
      currency: "INR",
      customer: { email: "a@b.c" },
    });
    expect(r.providerOrderId).toBe("mock_order_o1");
    expect(r.clientPayload).toEqual({
      mock: true,
      providerOrderId: "mock_order_o1",
      amount: "10.00",
      currency: "INR",
    });
  });

  it("verifies only a correct signature", async () => {
    const sig = signMockPayment("mock_order_o1", "pay_1");
    expect(sig).toBe(p.signMockPayment("mock_order_o1", "pay_1"));
    const ok = await p.verifyPayment({
      providerOrderId: "mock_order_o1",
      providerPaymentId: "pay_1",
      signature: sig,
    });
    expect(ok).toMatchObject({ verified: true, status: "PAID" });
    for (const signature of ["bad", undefined, sig.slice(1)]) {
      const r = await p.verifyPayment({
        providerOrderId: "mock_order_o1",
        providerPaymentId: "pay_1",
        signature,
      });
      expect(r.verified).toBe(false);
    }
  });

  it("handles signed webhooks and rejects unsigned", async () => {
    const body = Buffer.from(
      JSON.stringify({ id: "e1", type: "payment", orderId: "o", paymentId: "p", status: "PAID" }),
    );
    const ev = await p.handleWebhook(body, { "x-mock-signature": p.signWebhookBody(body) });
    expect(ev).toMatchObject({ eventId: "e1", providerOrderId: "o", status: "PAID" });
    await expect(p.handleWebhook(body, { "x-mock-signature": "nope" })).rejects.toMatchObject({
      status: 401,
    });
    await expect(p.handleWebhook(body, {})).rejects.toBeInstanceOf(AppError);
  });

  it("refunds idempotently", async () => {
    const input = {
      providerPaymentId: "p",
      amount: "1.00",
      currency: "INR",
      idempotencyKey: "k1",
    };
    const a = await p.refundPayment(input);
    expect(a).toEqual({ providerRefundId: "mock_refund_k1", status: "PROCESSED" });
    expect(await p.refundPayment(input)).toEqual(a);
  });

  it("refuses production unless allowed", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new MockPaymentProvider()).toThrow();
      expect(() => new MockPaymentProvider({ allowInProduction: true })).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("ManualPaymentProvider", () => {
  const p = new ManualPaymentProvider();
  it("is pending-only", async () => {
    const c = await p.createPayment({
      orderId: "o",
      orderNumber: "N",
      amount: "1.00",
      currency: "INR",
      customer: { email: "a@b.c" },
    });
    expect(c.status).toBe("PENDING");
    expect(c.clientPayload).toEqual({ manual: true });
    expect(
      await p.verifyPayment({ providerOrderId: "a", providerPaymentId: "b", signature: "x" }),
    ).toMatchObject({ verified: false, status: "PENDING" });
    await expect(p.handleWebhook()).rejects.toBeInstanceOf(AppError);
    const r = await p.refundPayment({
      providerPaymentId: "p",
      amount: "1.00",
      currency: "INR",
      idempotencyKey: "k",
    });
    expect(r.status).toBe("PENDING");
  });
});

describe("RazorpayProvider", () => {
  it("creates an order with basic auth and minor units, never leaking the secret", async () => {
    const f = fakeFetch(200, { id: "order_ABC" });
    const r = await rzp(f).createPayment({
      orderId: "o1",
      orderNumber: "N-100",
      amount: "499.50",
      currency: "INR",
      customer: { email: "a@b.c" },
      metadata: { foo: "bar" },
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64"),
    );
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ amount: 49950, currency: "INR", receipt: "N-100" });
    expect(body.notes).toMatchObject({ orderId: "o1", foo: "bar" });
    expect(r.providerOrderId).toBe("order_ABC");
    expect(r.clientPayload).toEqual({
      keyId: KEY_ID,
      providerOrderId: "order_ABC",
      amount: 49950,
      currency: "INR",
      name: "Shop",
    });
    expect(JSON.stringify(r)).not.toContain(KEY_SECRET);
  });

  it("verifies signatures (pass, fail, tamper, length mismatch, ignores client status)", async () => {
    const p = rzp(fakeFetch(200, {}));
    const sig = hmac("order_1|pay_1", KEY_SECRET);
    expect(
      await p.verifyPayment({
        providerOrderId: "order_1",
        providerPaymentId: "pay_1",
        signature: sig,
      }),
    ).toMatchObject({ verified: true, status: "PAID" });
    const tampered = (s: string) => (s[0] === "a" ? "b" : "a") + s.slice(1);
    const cases = [
      { providerOrderId: "order_1", providerPaymentId: "pay_1", signature: tampered(sig) },
      { providerOrderId: "order_2", providerPaymentId: "pay_1", signature: sig },
      { providerOrderId: "order_1", providerPaymentId: "pay_1", signature: sig.slice(0, 10) },
      { providerOrderId: "order_1", providerPaymentId: "pay_1", signature: sig + "00" },
      { providerOrderId: "order_1", providerPaymentId: "pay_1" },
      {
        providerOrderId: "order_1",
        providerPaymentId: "pay_1",
        signature: "bad",
        raw: { status: "captured" },
      },
    ];
    for (const c of cases) {
      const r = await p.verifyPayment(c);
      expect(r).toMatchObject({ verified: false, status: "FAILED" });
    }
  });

  describe("webhook", () => {
    const p = rzp(fakeFetch(200, {}));
    const mk = (event: string, payload: object) => Buffer.from(JSON.stringify({ event, payload }));
    const sign = (b: Buffer) => ({ "x-razorpay-signature": hmac(b, WH_SECRET) });

    it("maps captured to PAID with decimal amount and header event id", async () => {
      const b = mk("payment.captured", {
        payment: { entity: { id: "pay_1", order_id: "order_1", amount: 49950 } },
      });
      const ev = await p.handleWebhook(b, { ...sign(b), "x-razorpay-event-id": "evt_9" });
      expect(ev).toEqual({
        eventId: "evt_9",
        type: "payment.captured",
        providerOrderId: "order_1",
        providerPaymentId: "pay_1",
        status: "PAID",
        amount: "499.50",
      });
    });

    it("falls back to a body hash event id (stable for replays)", async () => {
      const b = mk("payment.failed", { payment: { entity: { id: "pay_1", order_id: "o" } } });
      const a = await p.handleWebhook(b, sign(b));
      const c = await p.handleWebhook(b, sign(b));
      expect(a.status).toBe("FAILED");
      expect(a.eventId).toMatch(/^[0-9a-f]{64}$/);
      expect(a.eventId).toBe(c.eventId);
    });

    it("maps order.paid and refund.processed", async () => {
      const b1 = mk("order.paid", { order: { entity: { id: "order_1", amount_paid: 1000 } } });
      expect(await p.handleWebhook(b1, sign(b1))).toMatchObject({
        status: "PAID",
        providerOrderId: "order_1",
        amount: "10.00",
      });
      const b2 = mk("refund.processed", {
        refund: { entity: { payment_id: "pay_1", amount: 250 } },
      });
      expect(await p.handleWebhook(b2, sign(b2))).toMatchObject({
        status: "REFUNDED",
        providerPaymentId: "pay_1",
        amount: "2.50",
      });
      const b3 = mk("something.else", {});
      expect((await p.handleWebhook(b3, sign(b3))).status).toBeUndefined();
    });

    it("rejects bad or missing signatures before parsing", async () => {
      const b = Buffer.from("not json at all");
      await expect(p.handleWebhook(b, { "x-razorpay-signature": "zz" })).rejects.toMatchObject({
        status: 401,
      });
      await expect(p.handleWebhook(b, {})).rejects.toMatchObject({ status: 401 });
      const good = mk("payment.captured", {});
      await expect(
        p.handleWebhook(Buffer.concat([good, Buffer.from(" ")]), sign(good)),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("rejects validly signed malformed payloads with 400", async () => {
      const b = Buffer.from("not json");
      await expect(p.handleWebhook(b, sign(b))).rejects.toMatchObject({ status: 400 });
      const b2 = Buffer.from(JSON.stringify({ foo: 1 }));
      await expect(p.handleWebhook(b2, sign(b2))).rejects.toMatchObject({ status: 400 });
    });
  });

  it("refunds with idempotency header and maps status", async () => {
    for (const [s, expected] of [
      ["processed", "PROCESSED"],
      ["pending", "PENDING"],
      ["failed", "FAILED"],
    ] as const) {
      const f = fakeFetch(200, { id: "rfnd_1", status: s });
      const r = await rzp(f).refundPayment({
        providerPaymentId: "pay_1",
        amount: "100.25",
        currency: "INR",
        reason: "damaged",
        idempotencyKey: "idem-1",
      });
      const [url, init] = f.mock.calls[0]!;
      expect(url).toBe("https://api.razorpay.com/v1/payments/pay_1/refund");
      expect((init?.headers as Record<string, string>)["X-Refund-Idempotency"]).toBe("idem-1");
      expect(JSON.parse(init?.body as string)).toEqual({
        amount: 10025,
        notes: { reason: "damaged" },
      });
      expect(r).toEqual({ providerRefundId: "rfnd_1", status: expected });
    }
  });

  it("maps provider 500 / network / timeout to safe PROVIDER_ERROR", async () => {
    const leaky = { error: { description: `boom ${KEY_SECRET} internal-details` } };
    const input = {
      orderId: "o",
      orderNumber: "N",
      amount: "1.00",
      currency: "INR",
      customer: { email: "a@b.c" },
    };
    const err = await rzp(fakeFetch(500, leaky))
      .createPayment(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    const dump = JSON.stringify({ m: (err as Error).message, d: (err as AppError).details });
    expect(dump).not.toContain(KEY_SECRET);
    expect(dump).not.toContain("internal-details");

    const net = new RazorpayProvider({
      keyId: KEY_ID,
      keySecret: KEY_SECRET,
      webhookSecret: WH_SECRET,
      fetch: async () => {
        throw new Error(`ECONNRESET ${KEY_SECRET}`);
      },
    });
    const e2 = await net.createPayment(input).catch((e: unknown) => e);
    expect(e2).toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    expect(JSON.stringify({ m: (e2 as Error).message })).not.toContain(KEY_SECRET);
  });

  it("times out hung requests", async () => {
    vi.useFakeTimers();
    try {
      const p = new RazorpayProvider({
        keyId: KEY_ID,
        keySecret: KEY_SECRET,
        webhookSecret: WH_SECRET,
        fetch: (_u, init) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
          }),
      });
      const pr = p
        .refundPayment({
          providerPaymentId: "p",
          amount: "1.00",
          currency: "INR",
          idempotencyKey: "k",
        })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pr).toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CashfreeProvider", () => {
  const CF_APP_ID = "cf_app_id_test";
  const CF_SECRET = "cf_secret_key_test_12345";

  function cf(f: ReturnType<typeof fakeFetch>, isProduction = false) {
    return new CashfreeProvider({
      appId: CF_APP_ID,
      secretKey: CF_SECRET,
      isProduction,
      fetch: f,
      displayName: "Kash Commerce",
    });
  }

  it("creates payment order with 2023-08-01 API and sandbox URL, never leaking secret", async () => {
    const f = fakeFetch(200, {
      order_id: "ORD-101",
      cf_order_id: "cf_101",
      payment_session_id: "session_abc123",
      order_status: "ACTIVE",
    });
    const p = cf(f, false);
    const res = await p.createPayment({
      orderId: "ord_1",
      orderNumber: "ORD-101",
      amount: "499.00",
      currency: "INR",
      customer: { email: "shopper@example.com", name: "Shopper", phone: "9876543210" },
      metadata: { returnUrl: "https://shop.example.com/return" },
    });

    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://sandbox.cashfree.com/pg/orders");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-client-id"]).toBe(CF_APP_ID);
    expect(headers["x-client-secret"]).toBe(CF_SECRET);
    expect(headers["x-api-version"]).toBe("2023-08-01");

    expect(res.providerOrderId).toBe("ORD-101");
    expect(res.clientPayload).toMatchObject({
      paymentSessionId: "session_abc123",
      orderId: "ORD-101",
      environment: "sandbox",
      name: "Kash Commerce",
    });
    expect(JSON.stringify(res)).not.toContain(CF_SECRET);
  });

  it("verifies payment by fetching order payments status", async () => {
    const fSuccess = fakeFetch(200, [{ cf_payment_id: 998877, payment_status: "SUCCESS" }]);
    const p = cf(fSuccess);
    const okRes = await p.verifyPayment({
      providerOrderId: "ORD-101",
      providerPaymentId: "998877",
    });
    expect(okRes).toMatchObject({ verified: true, providerPaymentId: "998877", status: "PAID" });

    const fFail = fakeFetch(200, [{ cf_payment_id: 112233, payment_status: "USER_DROPPED" }]);
    const pFail = cf(fFail);
    const failRes = await pFail.verifyPayment({
      providerOrderId: "ORD-101",
      providerPaymentId: "112233",
    });
    expect(failRes).toMatchObject({ verified: false, status: "FAILED" });
  });

  describe("webhook", () => {
    const p = cf(fakeFetch(200, {}));
    const timestamp = "1698480000";
    const sign = (raw: Buffer, ts = timestamp) => {
      const sig = createHmac("sha256", CF_SECRET)
        .update(ts + raw.toString("utf8"))
        .digest("base64");
      return {
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts,
      };
    };

    it("verifies webhook signature and maps PAYMENT_SUCCESS_WEBHOOK", async () => {
      const payload = {
        type: "PAYMENT_SUCCESS_WEBHOOK",
        event_time: "2026-10-28T12:00:00Z",
        data: {
          order: { order_id: "ORD-101", order_amount: 499.0 },
          payment: { cf_payment_id: 998877, payment_amount: 499.0, payment_status: "SUCCESS" },
        },
      };
      const raw = Buffer.from(JSON.stringify(payload));
      const ev = await p.handleWebhook(raw, sign(raw));
      expect(ev).toMatchObject({
        type: "PAYMENT_SUCCESS_WEBHOOK",
        providerOrderId: "ORD-101",
        providerPaymentId: "998877",
        status: "PAID",
        amount: "499",
      });
    });

    it("maps failed payment and refund webhooks", async () => {
      const failPayload = {
        type: "PAYMENT_FAILED_WEBHOOK",
        data: {
          order: { order_id: "ORD-101" },
          payment: { cf_payment_id: 112233, payment_status: "FAILED" },
        },
      };
      const failRaw = Buffer.from(JSON.stringify(failPayload));
      const failEv = await p.handleWebhook(failRaw, sign(failRaw));
      expect(failEv).toMatchObject({
        type: "PAYMENT_FAILED_WEBHOOK",
        providerOrderId: "ORD-101",
        status: "FAILED",
      });

      const refundPayload = {
        type: "REFUND_STATUS_WEBHOOK",
        data: {
          order: { order_id: "ORD-101" },
          refund: { cf_refund_id: "cf_ref_55", refund_amount: 100.0 },
        },
      };
      const refundRaw = Buffer.from(JSON.stringify(refundPayload));
      const refEv = await p.handleWebhook(refundRaw, sign(refundRaw));
      expect(refEv).toMatchObject({
        type: "REFUND_STATUS_WEBHOOK",
        providerOrderId: "ORD-101",
        providerPaymentId: "cf_ref_55",
        status: "REFUNDED",
      });
    });

    it("rejects invalid signature or missing timestamp with 401", async () => {
      const raw = Buffer.from(JSON.stringify({ type: "TEST" }));
      await expect(
        p.handleWebhook(raw, { "x-webhook-signature": "invalid_sig", "x-webhook-timestamp": "123" }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(p.handleWebhook(raw, {})).rejects.toMatchObject({ status: 401 });
    });
  });

  it("refunds with idempotencyKey and sanitizes upstream errors", async () => {
    const f = fakeFetch(200, {
      cf_refund_id: "cfr_88",
      refund_id: "ref_idem_1",
      refund_status: "SUCCESS",
    });
    const p = cf(f);
    const r = await p.refundPayment({
      providerPaymentId: "ORD-101",
      amount: "150.00",
      currency: "INR",
      reason: "Product return",
      idempotencyKey: "ref_idem_1",
    });
    expect(r).toEqual({ providerRefundId: "cfr_88", status: "PROCESSED" });

    // Upstream 500 error sanitization
    const f500 = fakeFetch(500, { message: `internal crash with ${CF_SECRET}` });
    const p500 = cf(f500);
    const err = await p500
      .refundPayment({
        providerPaymentId: "ORD-101",
        amount: "50.00",
        currency: "INR",
        idempotencyKey: "k2",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    expect(JSON.stringify({ m: (err as Error).message })).not.toContain(CF_SECRET);
  });
});
