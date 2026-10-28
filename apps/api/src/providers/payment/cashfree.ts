/* eslint-disable @typescript-eslint/no-explicit-any -- provider payloads are untyped JSON */
import { createHash, createHmac } from "node:crypto";
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
import { providerError, safeEqual, timedFetch, type FetchLike } from "./http";

export interface CashfreeOptions {
  appId: string;
  secretKey: string;
  isProduction?: boolean;
  baseUrl?: string;
  fetch?: FetchLike;
  displayName?: string;
  apiVersion?: string;
}

export class CashfreeProvider implements PaymentProvider {
  readonly key = "CASHFREE";
  private readonly appId: string;
  private readonly secretKey: string;
  private readonly isProduction: boolean;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private displayName?: string;

  constructor(opts: CashfreeOptions) {
    this.appId = opts.appId;
    this.secretKey = opts.secretKey;
    this.isProduction = opts.isProduction ?? false;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.apiVersion = opts.apiVersion ?? "2023-08-01";
    this.baseUrl = (
      opts.baseUrl ??
      (this.isProduction ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg")
    ).replace(/\/+$/, "");
    this.displayName = opts.displayName;
  }

  configure(opts: { displayName?: string }): void {
    if (opts.displayName) this.displayName = opts.displayName;
  }

  private headers(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      "x-client-id": this.appId,
      "x-client-secret": this.secretKey,
      "x-api-version": this.apiVersion,
      "Content-Type": "application/json",
      ...extraHeaders,
    };
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<any> {
    const res = await timedFetch(this.fetchFn, "Cashfree", `${this.baseUrl}${path}`, {
      method,
      headers: this.headers(extraHeaders),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok || !res.body) {
      throw providerError("Cashfree", `upstream responded with status ${res.status}`, res.status);
    }
    return res.body;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const customerId = (
      input.customer.email
        ? input.customer.email.replace(/[^a-zA-Z0-9_-]/g, "_")
        : `cust_${input.orderId}`
    ).slice(0, 50);

    const payload = {
      order_id: input.orderNumber,
      order_amount: parseFloat(input.amount),
      order_currency: input.currency,
      customer_details: {
        customer_id: customerId,
        customer_email: input.customer.email,
        customer_phone: input.customer.phone || "9999999999",
        customer_name: input.customer.name || undefined,
      },
      order_meta: {
        return_url: input.metadata?.returnUrl || undefined,
        notify_url: input.metadata?.notifyUrl || undefined,
      },
      order_note: input.orderId,
    };

    const data = await this.call("POST", "/orders", payload);

    const providerOrderId = data.order_id ?? input.orderNumber;
    const paymentSessionId = data.payment_session_id;

    if (!paymentSessionId) {
      throw providerError("Cashfree", "missing payment_session_id in order response");
    }

    return {
      providerOrderId,
      clientPayload: {
        paymentSessionId,
        orderId: providerOrderId,
        cfOrderId: data.cf_order_id,
        environment: this.isProduction ? "production" : "sandbox",
        currency: input.currency,
        amount: input.amount,
        ...(this.displayName ? { name: this.displayName } : {}),
      },
      status: "PENDING",
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    // 1. Fetch payments for the order from Cashfree
    const payments = await this.call(
      "GET",
      `/orders/${encodeURIComponent(input.providerOrderId)}/payments`,
    );

    const list: any[] = Array.isArray(payments) ? payments : [];
    const successful = list.find((p) => p.payment_status === "SUCCESS");

    if (successful) {
      return {
        verified: true,
        providerPaymentId: String(successful.cf_payment_id),
        status: "PAID",
      };
    }

    const failed = list.find((p) => p.payment_status === "FAILED" || p.payment_status === "USER_DROPPED");
    if (failed) {
      return {
        verified: false,
        providerPaymentId: String(failed.cf_payment_id ?? input.providerPaymentId),
        status: "FAILED",
      };
    }

    return {
      verified: false,
      providerPaymentId: input.providerPaymentId,
      status: "PENDING",
    };
  }

  async handleWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookEventResult> {
    const signature = headers["x-webhook-signature"] || headers["x-cashfree-signature"];
    const timestamp = headers["x-webhook-timestamp"] || headers["x-cashfree-timestamp"] || "";

    if (!signature) {
      throw new AppError(401, "UNAUTHENTICATED", "Missing Cashfree webhook signature");
    }

    // Cashfree computes: Base64(HMAC-SHA256(timestamp + rawBody, secretKey))
    const expected = createHmac("sha256", this.secretKey)
      .update(timestamp + rawBody.toString("utf8"))
      .digest("base64");

    if (!safeEqual(signature, expected)) {
      throw new AppError(401, "UNAUTHENTICATED", "Invalid Cashfree webhook signature");
    }

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new AppError(400, "BAD_REQUEST", "Malformed webhook payload");
    }

    if (!payload || typeof payload !== "object") {
      throw new AppError(400, "BAD_REQUEST", "Malformed webhook payload");
    }

    const eventId =
      headers["x-webhook-id"] || createHash("sha256").update(rawBody).digest("hex");
    const type: string = payload.type || payload.event || "UNKNOWN";

    let status: WebhookEventResult["status"];
    if (type === "PAYMENT_SUCCESS_WEBHOOK" || type === "ORDER_PAID_SUCCESS") {
      status = "PAID";
    } else if (
      type === "PAYMENT_FAILED_WEBHOOK" ||
      type === "PAYMENT_USER_DROPPED_WEBHOOK" ||
      type === "ORDER_FAILED"
    ) {
      status = "FAILED";
    } else if (type === "REFUND_STATUS_WEBHOOK" || type === "REFUND_SUCCESS") {
      status = "REFUNDED";
    }

    const providerOrderId = payload.data?.order?.order_id ?? payload.order_id;
    const providerPaymentId =
      payload.data?.payment?.cf_payment_id?.toString() ??
      payload.data?.refund?.cf_refund_id?.toString() ??
      payload.cf_payment_id?.toString();

    const rawAmount =
      payload.data?.payment?.payment_amount ??
      payload.data?.refund?.refund_amount ??
      payload.data?.order?.order_amount;
    const amount = rawAmount !== undefined ? String(rawAmount) : undefined;

    return {
      eventId,
      type,
      providerOrderId,
      providerPaymentId,
      status,
      amount,
    };
  }

  async refundPayment(input: RefundInput): Promise<RefundResult> {
    const data = await this.call(
      "POST",
      `/orders/${encodeURIComponent(input.providerPaymentId)}/refunds`,
      {
        refund_amount: parseFloat(input.amount),
        refund_id: input.idempotencyKey,
        refund_note: input.reason ?? "Customer refund",
      },
    );

    if (!data || typeof data !== "object") {
      throw providerError("Cashfree", "invalid refund response");
    }

    const s = data.refund_status;
    const status = s === "SUCCESS" ? "PROCESSED" : s === "FAILED" ? "FAILED" : "PENDING";

    return {
      providerRefundId: String(data.cf_refund_id ?? data.refund_id),
      status,
    };
  }
}
