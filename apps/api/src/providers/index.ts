import type {
  NotificationProvider,
  PaymentProvider,
  ShippingProvider,
  StorageProvider,
} from "@kash-commerce/provider-sdk";
import type { Env } from "@kash-commerce/config";
import type { PrismaClient } from "@kash-commerce/database";
import type { Logger } from "pino";

/**
 * Provider registry. Each kind maps provider-key -> implementation.
 * The *active* payment/shipping provider is chosen by env (PAYMENT_PROVIDER, SHIPPING_PROVIDER).
 * To add a provider: implement the interface from @kash-commerce/provider-sdk and register it in
 * buildProviders(). See docs/EXTENDING_PROVIDERS.md.
 */
export interface Providers {
  payment: Record<string, PaymentProvider>;
  shipping: Record<string, ShippingProvider>;
  notification: Record<string, NotificationProvider>;
  storage: StorageProvider;
  activePayment: string;
  activeShipping: string;
  activeNotification: string;
}

export function emptyProviders(): Providers {
  return {
    payment: {},
    shipping: {},
    notification: {},
    storage: {
      key: "LOCAL",
      put: async () => undefined,
      delete: async () => undefined,
      url: (k) => k,
    },
    activePayment: "MOCK",
    activeShipping: "MANUAL",
    activeNotification: "LOG",
  };
}

export interface ProviderDeps {
  env: Env;
  prisma: PrismaClient;
  logger: Logger;
}

// Implementations are registered by ./build.ts (kept separate to avoid circular imports).
export { buildProviders } from "./build";
