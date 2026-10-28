import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CashfreeProvider } from "../../src/providers/payment/cashfree";

const APP_ID = "cf_test_app_id";
const SECRET_KEY = "cf_test_secret_key_123456";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), { status });
  });
}

function cf(f: ReturnType<typeof fakeFetch>, isProduction = false) {
  return new CashfreeProvider({
    appId: APP_ID,
    secretKey: SECRET_KEY,
    isProduction,
    fetch: f,
    displayName: "Kash Commerce Store",
  });
}

describe("CashfreeProvider", () => {
  it("creates order with proper headers and payload", async () => {
    const f = fakeFetch(200, {
      order_id: "ORD-1234",
      cf_order_id: "123456789",
      payment_session_id: "session_abc123",
      order_status: "ACTIVE",
    });
    const provider = cf(f);

    const result = await provider.createPayment({
      orderId: "db_ord_1",
      orderNumber: "ORD-1234",
      amount: "499.50",
      currency: "INR",
      customer: {
        email: "buyer@example.com",
        name: "Jane Doe",
        phone: "9876543210",
      },
    });

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandbox.cashfree.com/pg/orders");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-client-id": APP_ID,
      "x-client-secret": SECRET_KEY,
      "x-api-version": "2023-08-01",
    });

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.order_id).toBe("ORD-1234");
    expect(sentBody.order_amount).toBe(499.5);
    expect(sentBody.order_currency).toBe("INR");
    expect(sentBody.customer_details.customer_email).toBe("buyer@example.com");

    expect(result.providerOrderId).toBe("ORD-1234");
    expect(result.status).toBe("PENDING");
    expect(result.clientPayload).toEqual({
      paymentSessionId: "session_abc123",
      orderId: "ORD-1234",
      cfOrderId: "123456789",
      environment: "sandbox",
      currency: "INR",
      amount: "499.50",
      name: "Kash Commerce Store",
    });
  });

  it("verifies payment via upstream order payments query", async () => {
    // 1. Success case
    const successFetch = fakeFetch(200, [
      {
        cf_payment_id: 99887766,
        payment_status: "SUCCESS",
        payment_amount: 499.5,
        payment_currency: "INR",
      },
    ]);
    const p1 = cf(successFetch);
    const v1 = await p1.verifyPayment({
      providerOrderId: "ORD-1234",
      providerPaymentId: "99887766",
    });
    expect(v1.verified).toBe(true);
    expect(v1.status).toBe("PAID");
    expect(v1.providerPaymentId).toBe("99887766");

    // 2. Failed case
    const failedFetch = fakeFetch(200, [
      {
        cf_payment_id: 11223344,
        payment_status: "FAILED",
      },
    ]);
    const p2 = cf(failedFetch);
    const v2 = await p2.verifyPayment({
      providerOrderId: "ORD-1234",
      providerPaymentId: "11223344",
    });
    expect(v2.verified).toBe(false);
    expect(v2.status).toBe("FAILED");
  });

  it("authenticates and parses webhook signatures", async () => {
    const provider = cf(fakeFetch(200, {}));

    const rawPayload = JSON.stringify({
      data: {
        order: { order_id: "ORD-1234", order_amount: 499.5, order_currency: "INR" },
        payment: { cf_payment_id: 888999, payment_status: "SUCCESS", payment_amount: 499.5 },
      },
      event_time: "2026-10-28T10:00:00Z",
      type: "PAYMENT_SUCCESS_WEBHOOK",
    });
    const rawBuffer = Buffer.from(rawPayload, "utf8");
    const timestamp = "1720000000";

    // Expected Base64 HMAC
    const signature = createHmac("sha256", SECRET_KEY)
      .update(timestamp + rawPayload)
      .digest("base64");

    // Successful webhook verification
    const event = await provider.handleWebhook(rawBuffer, {
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signature,
      "x-webhook-id": "evt-123",
    });

    expect(event.eventId).toBe("evt-123");
    expect(event.type).toBe("PAYMENT_SUCCESS_WEBHOOK");
    expect(event.status).toBe("PAID");
    expect(event.providerOrderId).toBe("ORD-1234");
    expect(event.providerPaymentId).toBe("888999");
    expect(event.amount).toBe("499.5");

    // Invalid signature -> throws 401
    await expect(
      provider.handleWebhook(rawBuffer, {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": "invalid-sig",
      }),
    ).rejects.toMatchObject({ status: 401 });

    // Missing signature -> throws 401
    await expect(provider.handleWebhook(rawBuffer, {})).rejects.toMatchObject({ status: 401 });
  });

  it("handles refunds via upstream API", async () => {
    const f = fakeFetch(200, {
      cf_refund_id: "cfr_554433",
      refund_id: "ref_idem_01",
      refund_status: "SUCCESS",
    });
    const provider = cf(f);

    const result = await provider.refundPayment({
      providerPaymentId: "ORD-1234",
      amount: "200.00",
      currency: "INR",
      reason: "Customer requested return",
      idempotencyKey: "ref_idem_01",
    });

    expect(result.providerRefundId).toBe("cfr_554433");
    expect(result.status).toBe("PROCESSED");
  });
});
