import { describe, expect, it } from "vitest";
import {
  buildEnv,
  buildStoreConfig,
  nextSteps,
  slugify,
  validateAnswers,
  type StoreAnswers,
} from "./generate";

const base: StoreAnswers = {
  storeName: "Acme Goods",
  storeSlug: "acme-goods",
  currency: "INR",
  locale: "en-IN",
  timezone: "Asia/Kolkata",
  paymentProvider: "RAZORPAY",
  shippingProvider: "SHIPROCKET",
  customerAccounts: true,
  reviews: true,
  blog: false,
  coupons: true,
  inventory: true,
  adminEmail: "owner@acme.test",
  taxMode: "INDIA_GST",
};

describe("create-store generators", () => {
  it("generates a fresh random secret every time and never an admin password", () => {
    const a = buildEnv(base);
    const b = buildEnv(base);
    const secret = (s: string) => /SESSION_SECRET=(\w+)/.exec(s)![1]!;
    expect(secret(a)).toHaveLength(64);
    expect(secret(a)).not.toBe(secret(b));
    expect(a).toMatch(/INITIAL_ADMIN_PASSWORD=\n/);
    expect(a).toContain("INITIAL_ADMIN_EMAIL=owner@acme.test");
  });

  it("leaves provider secrets blank and production-safe", () => {
    const env = buildEnv(base);
    expect(env).toMatch(/RAZORPAY_KEY_SECRET=\n/);
    expect(env).toMatch(/RAZORPAY_WEBHOOK_SECRET=\n/);
    expect(env).toMatch(/SHIPROCKET_PASSWORD=\n/);
    expect(env).toContain("COOKIE_SECURE=true");
    expect(env).toContain("NODE_ENV=production");
    expect(env).not.toContain("PAYMENT_PROVIDER=MOCK");
  });

  it("derives a safe database name from the slug", () => {
    expect(buildEnv(base)).toContain("POSTGRES_DB=commerce_acme_goods");
  });

  it("maps answers to feature flags and tax preset without hard-coding a region", () => {
    const cfg = buildStoreConfig(base);
    expect(cfg.settings.features).toMatchObject({
      customerAccounts: true,
      reviews: true,
      blog: false,
      coupons: true,
      inventory: true,
    });
    expect(cfg.settings.tax).toEqual({ mode: "INDIA_GST", defaultRate: 18 });
    const us = buildStoreConfig({ ...base, currency: "USD", taxMode: "NONE" });
    expect(us.settings.tax).toEqual({ mode: "NONE", defaultRate: 0 });
    expect(us.settings.checkout.requirePhone).toBe(false);
  });

  it("validates input", () => {
    expect(validateAnswers(base)).toBeNull();
    expect(validateAnswers({ ...base, storeName: " " })).toMatch(/name/i);
    expect(validateAnswers({ ...base, storeSlug: "Bad Slug" })).toMatch(/slug/i);
    expect(validateAnswers({ ...base, currency: "rupees" })).toMatch(/currency/i);
    expect(validateAnswers({ ...base, timezone: "Mars/Base" })).toMatch(/timezone/i);
    expect(validateAnswers({ ...base, adminEmail: "nope" })).toMatch(/email/i);
  });

  it("lists exactly the provider secrets still needed", () => {
    expect(nextSteps(base, ".env")).toContain("RAZORPAY_KEY_ID");
    expect(nextSteps(base, ".env")).toContain("SHIPROCKET_EMAIL");
    expect(
      nextSteps({ ...base, paymentProvider: "MANUAL", shippingProvider: "MANUAL" }, ".env"),
    ).not.toContain("RAZORPAY");
  });

  it("slugifies names", () => {
    expect(slugify("  Café  Déco & Co. ")).toBe("cafe-deco-co");
    expect(slugify("!!!")).toBe("store");
  });
});
