import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGINS: z.string().default(""),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  COOKIE_SECURE: bool,
  COOKIE_DOMAIN: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  STORAGE_PROVIDER: z.enum(["LOCAL", "S3"]).default("LOCAL"),
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(8),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(["MOCK", "MANUAL", "RAZORPAY"]).default("MOCK"),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  SHIPPING_PROVIDER: z.enum(["MANUAL", "MOCK", "SHIPROCKET"]).default("MANUAL"),
  SHIPROCKET_EMAIL: z.string().optional(),
  SHIPROCKET_PASSWORD: z.string().optional(),
  EMAIL_PROVIDER: z.enum(["LOG", "SMTP"]).default("LOG"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default("store@example.com"),
});

export type Env = Omit<z.infer<typeof schema>, "CORS_ORIGINS"> & { CORS_ORIGINS: string[] };

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const env = parsed.data;
  const origins = env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.includes("*")) throw new Error("CORS_ORIGINS must not contain '*'");
  const problems: string[] = [];
  if (env.NODE_ENV === "production") {
    if (!env.COOKIE_SECURE) problems.push("COOKIE_SECURE must be true in production");
    if (env.PAYMENT_PROVIDER === "MOCK")
      problems.push("PAYMENT_PROVIDER=MOCK is not allowed in production");
    if (env.SESSION_SECRET.startsWith("replace-with"))
      problems.push("SESSION_SECRET is still the example value");
  }
  if (
    env.PAYMENT_PROVIDER === "RAZORPAY" &&
    !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET)
  )
    problems.push(
      "RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required for RAZORPAY",
    );
  if (env.SHIPPING_PROVIDER === "SHIPROCKET" && !(env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD))
    problems.push("SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD are required for SHIPROCKET");
  if (
    env.STORAGE_PROVIDER === "S3" &&
    !(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)
  )
    problems.push("S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY are required for S3 storage");
  if (env.EMAIL_PROVIDER === "SMTP" && !env.SMTP_HOST)
    problems.push("SMTP_HOST is required for SMTP");
  if (problems.length)
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  return { ...env, CORS_ORIGINS: origins };
}
