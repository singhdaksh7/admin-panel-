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

/** COD / bank transfer. Admin marks orders paid / refunded through the order API. */
export class ManualPaymentProvider implements PaymentProvider {
  readonly key = "MANUAL";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return {
      providerOrderId: `manual_${input.orderNumber}`,
      clientPayload: { manual: true },
      status: "PENDING",
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return { verified: false, providerPaymentId: input.providerPaymentId, status: "PENDING" };
  }

  async handleWebhook(): Promise<WebhookEventResult> {
    throw new AppError(400, "BAD_REQUEST", "Webhooks are not supported by the MANUAL provider");
  }

  async refundPayment(input: RefundInput): Promise<RefundResult> {
    return { providerRefundId: `manual_refund_${input.idempotencyKey}`, status: "PENDING" };
  }
}
