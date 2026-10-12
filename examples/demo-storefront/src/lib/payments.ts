/**
 * Browser-side payment helpers for the checkout page.
 *
 * - Razorpay: loads Razorpay's hosted checkout.js and opens it with the `clientPayload` the API
 *   returned. The three values handed to `handler` are posted to `commerce.payments.verify`.
 * - MOCK (non-production API only): a DEMO-ONLY helper that signs a fake payment in the browser.
 *   The mock provider's secret is a public development constant, so this can NEVER work (or be
 *   used) against a production API where the MOCK provider is disabled. Real providers always
 *   verify server-side with a secret the browser never sees.
 */
import type { ClientPayload } from "@kash-commerce/storefront-sdk";

export interface PaymentProof {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => {
      open(): void;
      on(ev: string, cb: (r: unknown) => void): void;
    };
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment provider script"));
    document.head.appendChild(s);
  });
}

export function payWithRazorpay(
  payload: ClientPayload,
  prefill: { name?: string; email?: string; contact?: string },
): Promise<PaymentProof> {
  return loadScript("https://checkout.razorpay.com/v1/checkout.js").then(
    () =>
      new Promise<PaymentProof>((resolve, reject) => {
        if (!window.Razorpay) return reject(new Error("Razorpay is unavailable"));
        const rzp = new window.Razorpay({
          key: payload.keyId,
          order_id: payload.providerOrderId,
          amount: payload.amount, // already integer minor units for Razorpay
          currency: payload.currency,
          name: (payload as { name?: string }).name,
          prefill,
          handler: (r: Record<string, string>) =>
            resolve({
              providerOrderId: r.razorpay_order_id ?? "",
              providerPaymentId: r.razorpay_payment_id ?? "",
              signature: r.razorpay_signature ?? "",
            }),
          modal: { ondismiss: () => reject(new Error("Payment was cancelled")) },
        });
        rzp.on("payment.failed", () => reject(new Error("Payment failed")));
        rzp.open();
      }),
  );
}

const DEV_MOCK_SECRET = "mock-payment-test-secret-not-for-production";

/** DEMO ONLY: HMAC-SHA256(providerOrderId|providerPaymentId) with the public dev mock secret. */
export async function signMockPayment(providerOrderId: string): Promise<PaymentProof> {
  const secret = import.meta.env.VITE_MOCK_PAYMENT_SECRET ?? DEV_MOCK_SECRET;
  const providerPaymentId = `mock_pay_${Math.random().toString(36).slice(2, 10)}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${providerOrderId}|${providerPaymentId}`),
  );
  const signature = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { providerOrderId, providerPaymentId, signature };
}
