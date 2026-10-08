export interface CreatePaymentInput {
  orderId: string;
  orderNumber: string;
  /** decimal string e.g. "499.00" */
  amount: string;
  currency: string;
  customer: { email: string; name?: string; phone?: string };
  metadata?: Record<string, string>;
}
export interface CreatePaymentResult {
  providerOrderId: string;
  /** Data the storefront needs to complete payment (e.g. key id + order id). NEVER secrets. */
  clientPayload: Record<string, unknown>;
  status: "PENDING" | "PAID";
}
export interface VerifyPaymentInput {
  providerOrderId: string;
  providerPaymentId: string;
  signature?: string;
  raw?: Record<string, unknown>;
}
export interface VerifyPaymentResult {
  verified: boolean;
  providerPaymentId: string;
  status: "PAID" | "FAILED" | "PENDING";
}
export interface WebhookEventResult {
  eventId: string;
  type: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  status?: "PAID" | "FAILED" | "REFUNDED";
  amount?: string;
}
export interface RefundInput {
  providerPaymentId: string;
  amount: string;
  currency: string;
  reason?: string;
  idempotencyKey: string;
}
export interface RefundResult {
  providerRefundId: string;
  status: "PROCESSED" | "PENDING" | "FAILED";
}

export interface PaymentProvider {
  readonly key: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  /** Must verify the signature using the RAW body and throw on mismatch. */
  handleWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookEventResult>;
  refundPayment(input: RefundInput): Promise<RefundResult>;
}
