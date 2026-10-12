import { emptyProviders, type ProviderDeps, type Providers } from "./index";
import { createLogEmailProvider, createSmtpEmailProvider } from "../modules/notifications/service";
import { LocalStorageProvider, S3CompatibleStorageProvider } from "./storage";

/** Wire provider implementations here (payment/shipping/notification/storage). */
export function buildProviders(deps: ProviderDeps): Providers {
  const providers = emptyProviders();
  providers.activePayment = deps.env.PAYMENT_PROVIDER;
  providers.activeShipping = deps.env.SHIPPING_PROVIDER;
  providers.activeNotification = deps.env.EMAIL_PROVIDER;
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
