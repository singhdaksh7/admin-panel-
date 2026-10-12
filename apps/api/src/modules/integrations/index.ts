import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@kash-commerce/database";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requirePermission } from "../../middleware/adminAuth";
import { safeProviderMessage } from "../payments/access";
import {
  KINDS,
  KNOWN,
  activeProviderOf,
  applyIntegrationConfig,
  findKnown,
  findSecretKey,
  type IntegrationKind,
} from "./service";

const putBody = z.object({
  enabled: z.boolean(),
  config: z.record(z.unknown()).default({}),
});
const ratesTestBody = z.object({
  postalCode: z.string().trim().min(1).max(20),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase())
    .default("IN"),
  weightGrams: z.number().int().min(1).max(100000).default(500),
  paymentMode: z.enum(["PREPAID", "COD"]).default("PREPAID"),
  provider: z.string().trim().max(40).optional(),
});

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const admin = Router();

  // best-effort: push stored non-secret options into live providers at startup
  void Promise.all([
    applyIntegrationConfig(ctx, "PAYMENT", "RAZORPAY"),
    applyIntegrationConfig(ctx, "SHIPPING", "SHIPROCKET"),
  ]).catch((err) => ctx.logger.debug({ err }, "could not apply stored integration settings"));

  const secretsFor = (names: string[]) =>
    Object.fromEntries(
      names.map((n) => [n, !!(ctx.env as unknown as Record<string, unknown>)[n]]),
    ) as Record<string, boolean>;

  admin.get(
    "/integrations",
    requirePermission("integrations.manage"),
    h(async (_req, res) => {
      const rows = await p.integrationSetting.findMany();
      const out = KINDS.map((kind) => {
        const active = activeProviderOf(ctx, kind);
        return {
          kind,
          providers: KNOWN.filter(
            (k) => k.kind === kind && !(k.devOnly && ctx.env.NODE_ENV === "production"),
          ).map((k) => {
            const row = rows.find((r) => r.kind === kind && r.provider === k.provider);
            const isActive = active === k.provider;
            return {
              kind,
              provider: k.provider,
              label: k.label,
              enabled: row
                ? row.enabled
                : isActive || (kind === "PAYMENT" && k.provider === "MANUAL"),
              isActive,
              registered:
                kind === "PAYMENT"
                  ? !!ctx.providers.payment[k.provider]
                  : kind === "SHIPPING"
                    ? !!ctx.providers.shipping[k.provider]
                    : isActive,
              config: (row?.config ?? {}) as Record<string, unknown>,
              secretsConfigured: secretsFor(k.secretEnv),
            };
          }),
        };
      });
      res.json({ kinds: out });
    }),
  );

  admin.put(
    "/integrations/:kind/:provider",
    requirePermission("integrations.manage"),
    h(async (req, res) => {
      const kind = String(req.params.kind).toUpperCase();
      const provider = String(req.params.provider).toUpperCase();
      const known = findKnown(kind, provider);
      if (!known || (known.devOnly && ctx.env.NODE_ENV === "production"))
        throw AppError.notFound("Integration");
      const body = parse(putBody, req.body);
      const bad = findSecretKey(body.config);
      if (bad)
        throw AppError.validation(
          `"${bad}" looks like a secret: secrets are set via environment variables, not stored here`,
        );
      const config = parse(known.config, body.config);
      const before = await p.integrationSetting.findUnique({
        where: { kind_provider: { kind, provider } },
      });
      const row = await p.integrationSetting.upsert({
        where: { kind_provider: { kind, provider } },
        create: { kind, provider, enabled: body.enabled, config: config as Prisma.InputJsonValue },
        update: { enabled: body.enabled, config: config as Prisma.InputJsonValue },
      });
      if (kind === "PAYMENT" || kind === "SHIPPING")
        await applyIntegrationConfig(ctx, kind, provider, config);
      await audit(ctx, req, {
        action: "integration.update",
        entityType: "IntegrationSetting",
        entityId: row.id,
        before: before ? { enabled: before.enabled, config: before.config } : null,
        after: { kind, provider, enabled: row.enabled, config: row.config },
      });
      res.json({
        kind,
        provider,
        enabled: row.enabled,
        isActive: activeProviderOf(ctx, kind as IntegrationKind) === provider,
        config: row.config,
        secretsConfigured: secretsFor(known.secretEnv),
      });
    }),
  );

  admin.post(
    "/integrations/shipping/rates-test",
    requirePermission("integrations.manage"),
    h(async (req, res) => {
      const b = parse(ratesTestBody, req.body ?? {});
      const key = (b.provider ?? ctx.providers.activeShipping).toUpperCase();
      const impl = ctx.providers.shipping[key];
      if (!impl) throw AppError.notFound("Shipping provider");
      await applyIntegrationConfig(ctx, "SHIPPING", key);
      try {
        const rates = await impl.getRates({
          destination: {
            name: "Rates Test",
            line1: "Test",
            city: "Test",
            postalCode: b.postalCode,
            country: b.country,
          },
          items: [
            {
              name: "Test item",
              sku: "TEST",
              quantity: 1,
              unitPrice: "1.00",
              weightGrams: b.weightGrams,
            },
          ],
          subtotal: "1.00",
          currency: "INR",
          paymentMode: b.paymentMode,
        });
        res.json({ provider: key, ok: true, rates });
      } catch (err) {
        res.json({
          provider: key,
          ok: false,
          rates: [],
          error: safeProviderMessage(err, "Rates could not be fetched"),
        });
      }
    }),
  );

  return { admin };
}
