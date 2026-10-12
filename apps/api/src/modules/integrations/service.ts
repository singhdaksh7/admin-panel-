import { z } from "zod";
import type { AppContext } from "../../context";

export const KINDS = ["PAYMENT", "SHIPPING", "NOTIFICATION", "STORAGE"] as const;
export type IntegrationKind = (typeof KINDS)[number];

export interface KnownProvider {
  kind: IntegrationKind;
  provider: string;
  label: string;
  /** names of ENV VARS that hold this provider's secrets (values are never read out) */
  secretEnv: string[];
  /** zod schema of the NON-SECRET options an admin may store */
  config: z.ZodObject<z.ZodRawShape>;
  /** mock providers exist only outside production */
  devOnly?: boolean;
}

const empty = z.object({}).strict();
const str = (max: number) => z.string().trim().max(max);

export const KNOWN: KnownProvider[] = [
  {
    kind: "PAYMENT",
    provider: "RAZORPAY",
    label: "Razorpay",
    secretEnv: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
    config: z.object({ displayName: str(100).optional() }).strict(),
  },
  {
    kind: "PAYMENT",
    provider: "MANUAL",
    label: "Manual / Cash on delivery",
    secretEnv: [],
    config: z.object({ instructions: str(500).optional() }).strict(),
  },
  {
    kind: "PAYMENT",
    provider: "MOCK",
    label: "Mock (testing)",
    secretEnv: [],
    config: empty,
    devOnly: true,
  },
  {
    kind: "SHIPPING",
    provider: "SHIPROCKET",
    label: "Shiprocket",
    secretEnv: ["SHIPROCKET_EMAIL", "SHIPROCKET_PASSWORD"],
    config: z
      .object({
        pickupLocation: str(100).optional(),
        pickupPostcode: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9 -]{3,12}$/, "Invalid postcode")
          .optional(),
      })
      .strict(),
  },
  { kind: "SHIPPING", provider: "MANUAL", label: "Manual shipping", secretEnv: [], config: empty },
  {
    kind: "SHIPPING",
    provider: "MOCK",
    label: "Mock (testing)",
    secretEnv: [],
    config: empty,
    devOnly: true,
  },
  {
    kind: "NOTIFICATION",
    provider: "LOG",
    label: "Log only",
    secretEnv: [],
    config: z.object({ fromName: str(100).optional() }).strict(),
  },
  {
    kind: "NOTIFICATION",
    provider: "SMTP",
    label: "SMTP email",
    secretEnv: ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"],
    config: z.object({ fromName: str(100).optional() }).strict(),
  },
  { kind: "STORAGE", provider: "LOCAL", label: "Local disk", secretEnv: [], config: empty },
  {
    kind: "STORAGE",
    provider: "S3",
    label: "S3-compatible",
    secretEnv: ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    config: z.object({ publicBaseUrl: z.string().trim().url().max(300).optional() }).strict(),
  },
];

export function findKnown(kind: string, provider: string): KnownProvider | undefined {
  return KNOWN.find((k) => k.kind === kind && k.provider === provider);
}

export const SECRET_KEY = /secret|password|token|key/i;

/** Returns the first secret-looking key path found anywhere in a JSON value. */
export function findSecretKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const r = findSecretKey(v, `${path}[${i}]`);
      if (r) return r;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) return path ? `${path}.${k}` : k;
      const r = findSecretKey(v, path ? `${path}.${k}` : k);
      if (r) return r;
    }
  }
  return null;
}

export function activeProviderOf(ctx: AppContext, kind: IntegrationKind): string {
  switch (kind) {
    case "PAYMENT":
      return ctx.providers.activePayment;
    case "SHIPPING":
      return ctx.providers.activeShipping;
    case "NOTIFICATION":
      return ctx.providers.activeNotification;
    case "STORAGE":
      return ctx.env.STORAGE_PROVIDER;
  }
}

/** Pushes stored non-secret settings into the live provider instance (if it supports `configure`). */
export async function applyIntegrationConfig(
  ctx: AppContext,
  kind: "PAYMENT" | "SHIPPING",
  provider: string,
  stored?: Record<string, unknown>,
): Promise<void> {
  const impl = (kind === "PAYMENT" ? ctx.providers.payment : ctx.providers.shipping)[provider] as
    { configure?: (o: Record<string, unknown>) => void } | undefined;
  if (!impl?.configure) return;
  let config = stored;
  if (!config) {
    const row = await ctx.prisma.integrationSetting.findUnique({
      where: { kind_provider: { kind, provider } },
    });
    config = (row?.config ?? {}) as Record<string, unknown>;
  }
  impl.configure(config);
}
