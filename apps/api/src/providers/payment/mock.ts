import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
  WebhookEventResult,
} from "@kash-commerce/provider-sdk";
import { AppError } from "@kash-commerce/shared";
import { hmacHex, safeEqual } from "./http";

export const MOCK_PAYMENT_SECRET = "mock-payment-test-secret-not-for-production";

export interface MockPaymentOptions {
  secret?: string;
  /** Explicit opt-in to construct under NODE_ENV=production (never do this for real). */
  allowInProduction?: boolean;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly key = "MOCK";
  private readonly secret: string;
  private readonly refunds = new Map<string, RefundResult>();

  constructor(opts: MockPaymentOptions = {}) {
    if (process.env.NODE_ENV === "production" && !opts.allowInProduction)
      throw new Error("MockPaymentProvider cannot be used when NODE_ENV=production");
    this.secret = opts.secret ?? MOCK_PAYMENT_SECRET;
  }

  signMockPayment(providerOrderId: string, providerPaymentId: string): string {
    return hmacHex(`${providerOrderId}|${providerPaymentId}`, this.secret);
  }

  /** Signs a raw webhook body for tests (header x-mock-signature). */
  signWebhookBody(rawBody: string | Buffer): string {
    return hmacHex(rawBody, this.secret);
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const providerOrderId = `mock_order_${input.orderId}`;
    return {
      providerOrderId,
      clientPayload: {
        mock: true,
        providerOrderId,
        amount: input.amount,
        currency: input.currency,
      },
      status: "PENDING",
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const expected = this.signMockPayment(input.providerOrderId, input.providerPaymentId);
    const ok = typeof input.signature === "string" && safeEqual(input.signature, expected);
    return {
      verified: ok,
      providerPaymentId: input.providerPaymentId,
      status: ok ? "PAID" : "FAILED",
    };
  }

  async handleWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookEventResult> {
    const sig = headers["x-mock-signature"];
    if (!sig || !safeEqual(sig, hmacHex(rawBody, this.secret)))
      throw new AppError(401, "UNAUTHENTICATED", "Invalid webhook signature");
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new AppError(400, "BAD_REQUEST", "Malformed webhook payload");
    }
    if (!p || typeof p.id !== "string" || typeof p.type !== "string")
      throw new AppError(400, "BAD_REQUEST", "Malformed webhook payload");
    const status = p.status;
    return {
      eventId: p.id,
      type: p.type,
      providerOrderId: typeof p.orderId === "string" ? p.orderId : undefined,
      providerPaymentId: typeof p.paymentId === "string" ? p.paymentId : undefined,
      status:
        status === "PAID" || status === "FAILED" || status === "REFUNDED" ? status : undefined,
      amount: typeof p.amount === "string" ? p.amount : undefined,
    };
  }

  async refundPayment(input: RefundInput): Promise<RefundResult> {
    const existing = this.refunds.get(input.idempotencyKey);
    if (existing) return existing;
    const result: RefundResult = {
      providerRefundId: `mock_refund_${input.idempotencyKey}`,
      status: "PROCESSED",
    };
    this.refunds.set(input.idempotencyKey, result);
    return result;
  }
}

/** Sign with the default test secret (for instances created without a custom secret). */
export function signMockPayment(providerOrderId: string, providerPaymentId: string): string {
  return hmacHex(`${providerOrderId}|${providerPaymentId}`, MOCK_PAYMENT_SECRET);
}
