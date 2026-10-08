import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";

export const featureFlags = z
  .object({
    customerAccounts: z.boolean().default(true),
    guestCheckout: z.boolean().default(true),
    reviews: z.boolean().default(true),
    blog: z.boolean().default(true),
    coupons: z.boolean().default(true),
    inventory: z.boolean().default(true),
  })
  .partial();

const address = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().length(2).optional(),
  })
  .partial();

const settingsBody = z
  .object({
    name: z.string().min(1).max(120),
    legalName: z.string().max(200).nullable(),
    logoMediaId: z.string().nullable(),
    faviconMediaId: z.string().nullable(),
    supportEmail: z.string().email().nullable(),
    phone: z.string().max(40).nullable(),
    address,
    currency: z.string().regex(/^[A-Z]{3}$/),
    locale: z.string().min(2).max(20),
    timezone: z.string().min(1).max(60),
    tax: z
      .object({
        mode: z.enum(["NONE", "EXCLUSIVE", "INCLUSIVE", "INDIA_GST"]),
        defaultRate: z.number().min(0).max(100),
        gstin: z.string().max(20).optional(),
        homeState: z.string().max(60).optional(),
      })
      .partial(),
    checkout: z
      .object({
        guestCheckout: z.boolean(),
        requirePhone: z.boolean(),
        minOrderAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
      })
      .partial(),
    features: featureFlags,
    social: z.record(z.string().url().max(300)),
  })
  .partial();

function isValidTz(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function getSettings(ctx: AppContext) {
  return ctx.prisma.storeSettings.upsert({
    where: { id: "store" },
    create: { id: "store" },
    update: {},
  });
}

/** Public projection: never expose internal-only fields. */
export function publicSettings(s: Awaited<ReturnType<typeof getSettings>>) {
  const t = (s.tax ?? {}) as Record<string, unknown>;
  return {
    name: s.name,
    legalName: s.legalName,
    logoMediaId: s.logoMediaId,
    faviconMediaId: s.faviconMediaId,
    supportEmail: s.supportEmail,
    phone: s.phone,
    address: s.address,
    currency: s.currency,
    locale: s.locale,
    timezone: s.timezone,
    tax: { mode: t.mode ?? "NONE", pricesIncludeTax: t.mode === "INCLUSIVE" },
    features: {
      customerAccounts: true,
      guestCheckout: true,
      reviews: true,
      blog: true,
      coupons: true,
      inventory: true,
      ...(s.features as object),
    },
    social: s.social,
  };
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const pub = Router();
  pub.get(
    "/store/settings",
    limiters.publicRead,
    h(async (_req, res) => {
      res.json(publicSettings(await getSettings(ctx)));
    }),
  );

  const admin = Router();
  admin.get(
    "/settings",
    requirePermission("settings.read"),
    h(async (_req, res) => {
      res.json(await getSettings(ctx));
    }),
  );
  admin.put(
    "/settings",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const body = parse(settingsBody, req.body);
      if (body.timezone && !isValidTz(body.timezone)) {
        return void res
          .status(422)
          .json({ error: { code: "VALIDATION_ERROR", message: "Unknown timezone" } });
      }
      const before = await getSettings(ctx);
      const { address: addr, tax, checkout, features, social, ...rest } = body;
      const data = {
        ...rest,
        ...(addr ? { address: { ...((before.address as object) ?? {}), ...addr } } : {}),
        ...(tax ? { tax: { ...((before.tax as object) ?? {}), ...tax } } : {}),
        ...(checkout ? { checkout: { ...((before.checkout as object) ?? {}), ...checkout } } : {}),
        ...(features ? { features: { ...((before.features as object) ?? {}), ...features } } : {}),
        ...(social ? { social } : {}),
      };
      const after = await ctx.prisma.storeSettings.update({ where: { id: "store" }, data });
      await audit(ctx, req, {
        action: "settings.update",
        entityType: "StoreSettings",
        entityId: "store",
        before,
        after: data,
      });
      res.json(after);
    }),
  );
  return { public: pub, admin };
}
