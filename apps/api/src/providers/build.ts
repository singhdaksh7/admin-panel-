import { emptyProviders, type ProviderDeps, type Providers } from "./index";
import { ManualPaymentProvider } from "./payment/manual";
import { MockPaymentProvider } from "./payment/mock";
import { RazorpayProvider } from "./payment/razorpay";
import { ManualShippingProvider } from "./shipping/manual";
import { MockShippingProvider } from "./shipping/mock";
import { ShiprocketProvider } from "./shipping/shiprocket";
import { createLogEmailProvider, createSmtpEmailProvider } from "../modules/notifications/service";

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
  if (env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD) {
    providers.shipping.SHIPROCKET = new ShiprocketProvider({
      email: env.SHIPROCKET_EMAIL,
      password: env.SHIPROCKET_PASSWORD,
    });
  }
  providers.notification.LOG = createLogEmailProvider(deps.logger);
  if (deps.env.EMAIL_PROVIDER === "SMTP")
    providers.notification.SMTP = createSmtpEmailProvider(deps.env);
  return providers;
}
