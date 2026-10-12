import { createPrisma } from "@kash-commerce/database";
import type { Prisma } from "@kash-commerce/database";
import { buildStoreConfig } from "./generate";

type StoreConfig = ReturnType<typeof buildStoreConfig>;

/** Idempotently writes the (non-secret) settings from store.config.json into StoreSettings. */
export async function applyStoreConfig(databaseUrl: string, cfg: StoreConfig): Promise<void> {
  const prisma = createPrisma(databaseUrl);
  try {
    const s = cfg.settings;
    const data = {
      name: s.name,
      currency: s.currency,
      locale: s.locale,
      timezone: s.timezone,
      tax: s.tax as Prisma.InputJsonValue,
      checkout: s.checkout as Prisma.InputJsonValue,
      features: s.features as Prisma.InputJsonValue,
    };
    await prisma.storeSettings.upsert({
      where: { id: "store" },
      create: { id: "store", ...data },
      update: data,
    });
  } finally {
    await prisma.$disconnect();
  }
}
