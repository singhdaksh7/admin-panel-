import { emptyProviders, type ProviderDeps, type Providers } from "./index";
import { createLogEmailProvider, createSmtpEmailProvider } from "../modules/notifications/service";

/** Wire provider implementations here (payment/shipping/notification/storage). */
export function buildProviders(deps: ProviderDeps): Providers {
  const providers = emptyProviders();
  providers.activePayment = deps.env.PAYMENT_PROVIDER;
  providers.activeShipping = deps.env.SHIPPING_PROVIDER;
  providers.activeNotification = deps.env.EMAIL_PROVIDER;
  providers.notification.LOG = createLogEmailProvider(deps.logger);
  if (deps.env.EMAIL_PROVIDER === "SMTP")
    providers.notification.SMTP = createSmtpEmailProvider(deps.env);
  return providers;
}
