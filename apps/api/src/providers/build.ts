import { emptyProviders, type ProviderDeps, type Providers } from "./index";
import { ManualPaymentProvider } from "./payment/manual";
import { MockPaymentProvider } from "./payment/mock";
import { RazorpayProvider } from "./payment/razorpay";
import { CashfreeProvider } from "./payment/cashfree";
import { ManualShippingProvider } from "./shipping/manual";
import { MockShippingProvider } from "./shipping/mock";
import { ShiprocketProvider } from "./shipping/shiprocket";
import { createLogEmailProvider, createSmtpEmailProvider } from "../modules/notifications/service";
import { LocalStorageProvider, S3CompatibleStorageProvider } from "./storage";

/** Wire provider implementations here (payment/shipping/notification/storage). */
export function buildProviders(deps: ProviderDeps): Providers {
  const providers = emptyProviders();
  providers.activePayment = deps.env.PAYMENT_PROVIDER;
  providers.activeShipping = deps.env.SHIPPING_PROVIDER;
  providers.activeNotification = deps.env.EMAIL_PROVIDER;
  const { env } = deps;
  providers.payment.MANUAL = new ManualPaymentProvider();
  providers.shipping.MANUAL = new ManualShippingProvider();
  if (env.NODE_ENV !== "production") {
    providers.payment.MOCK = new MockPaymentProvider();
    providers.shipping.MOCK = new MockShippingProvider();
  }
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET) {
    providers.payment.RAZORPAY = new RazorpayProvider({
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    });
  }
  if (env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY) {
    providers.payment.CASHFREE = new CashfreeProvider({
      appId: env.CASHFREE_APP_ID,
      secretKey: env.CASHFREE_SECRET_KEY,
      isProduction: env.CASHFREE_ENV === "production",
    });
  }
  if (env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD) {
    providers.shipping.SHIPROCKET = new ShiprocketProvider({
      email: env.SHIPROCKET_EMAIL,
      password: env.SHIPROCKET_PASSWORD,
    });
  }
  providers.notification.LOG = createLogEmailProvider(deps.logger);
  if (deps.env.EMAIL_PROVIDER === "SMTP")
    providers.notification.SMTP = createSmtpEmailProvider(deps.env);
  providers.storage =
    deps.env.STORAGE_PROVIDER === "S3"
      ? new S3CompatibleStorageProvider({
          bucket: deps.env.S3_BUCKET!,
          region: deps.env.S3_REGION,
          endpoint: deps.env.S3_ENDPOINT,
          accessKeyId: deps.env.S3_ACCESS_KEY_ID!,
          secretAccessKey: deps.env.S3_SECRET_ACCESS_KEY!,
          publicBaseUrl: deps.env.S3_PUBLIC_BASE_URL,
        })
      : new LocalStorageProvider(deps.env.UPLOAD_DIR, deps.env.PUBLIC_API_URL);
  return providers;
}
