/* eslint-disable @typescript-eslint/no-explicit-any -- provider payloads are untyped JSON */
import { createHash } from "node:crypto";
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
import { AppError, fromMinor, toMinor } from "@kash-commerce/shared";
import { hmacHex, providerError, safeEqual, timedFetch, type FetchLike } from "./http";

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Shown in the checkout widget. */
  displayName?: string;
}

export class RazorpayProvider implements PaymentProvider {
  readonly key = "RAZORPAY";
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly displayName?: string;

  constructor(opts: RazorpayOptions) {
    this.keyId = opts.keyId;
    this.keySecret = opts.keySecret;
    this.webhookSecret = opts.webhookSecret;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? "https://api.razorpay.com").replace(/\/+$/, "");
    this.displayName = opts.displayName;
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
  }

  private async call(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const res = await timedFetch(this.fetchFn, "Razorpay", `${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body || typeof res.body !== "object")
      throw providerError("Razorpay", `upstream responded with status ${res.status}`, res.status);
    return res.body as Record<string, unknown>;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const amount = toMinor(input.amount);
    const data = await this.call("/v1/orders", {
      amount,
      currency: input.currency,
      receipt: input.orderNumber,
      notes: { orderId: input.orderId, ...(input.metadata ?? {}) },
    });
    const providerOrderId = data.id;
    if (typeof providerOrderId !== "string")
      throw providerError("Razorpay", "invalid order response");
    return {
      providerOrderId,
      clientPayload: {
        keyId: this.keyId,
        providerOrderId,
        amount,
        currency: input.currency,
        ...(this.displayName ? { name: this.displayName } : {}),
      },
      status: "PENDING",
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    // Client-supplied status is deliberately ignored; only the HMAC decides.
    const expected = hmacHex(`${input.providerOrderId}|${input.providerPaymentId}`, this.keySecret);
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
    const sig = headers["x-razorpay-signature"];
    if (!sig || !safeEqual(sig, hmacHex(rawBody, this.webhookSecret)))
      throw new AppError(401, "UNAUTHENTICATED", "Invalid webhook signature");

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new AppError(400, "BAD_REQUEST", "Malformed webhook payload");
    }
    if (!payload || typeof payload !== "object" || typeof payload.event !== "string")
      throw new AppError(400, "BAD_REQUEST", "Malformed webhook payload");

    const eventId =
      headers["x-razorpay-event-id"] || createHash("sha256").update(rawBody).digest("hex");
    const type: string = payload.event;
    const payment = payload.payload?.payment?.entity as Record<string, any> | undefined;
    const order = payload.payload?.order?.entity as Record<string, any> | undefined;
    const refund = payload.payload?.refund?.entity as Record<string, any> | undefined;

    let status: WebhookEventResult["status"];
    if (type === "payment.captured" || type === "order.paid") status = "PAID";
    else if (type === "payment.failed") status = "FAILED";
    else if (type === "refund.processed") status = "REFUNDED";

    const providerOrderId: string | undefined = payment?.order_id ?? order?.id;
    const providerPaymentId: string | undefined = payment?.id ?? refund?.payment_id;
    const minor =
      type === "refund.processed" ? refund?.amount : (payment?.amount ?? order?.amount_paid);
    const amount = Number.isInteger(minor) ? fromMinor(minor) : undefined;

    return { eventId, type, providerOrderId, providerPaymentId, status, amount };
  }

  async refundPayment(input: RefundInput): Promise<RefundResult> {
    const data = await this.call(
      `/v1/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      {
        amount: toMinor(input.amount),
        notes: input.reason ? { reason: input.reason } : {},
      },
      { "X-Refund-Idempotency": input.idempotencyKey },
    );
    if (typeof data.id !== "string") throw providerError("Razorpay", "invalid refund response");
    const s = data.status;
    const status = s === "processed" ? "PROCESSED" : s === "failed" ? "FAILED" : "PENDING";
    return { providerRefundId: data.id, status };
  }
}
