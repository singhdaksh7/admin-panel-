import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { AppError } from "@kash-commerce/shared";
import {
  DEFAULT_TEMPLATES,
  notify,
  render,
  retryNotification,
  type TemplateDefinition,
} from "./service";
import { renderHtmlEmail } from "./emailTemplate";

const updateTemplateBody = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  html: z.string().max(50_000).optional().nullable(),
  isEnabled: z.boolean().default(true),
});

const previewBody = z.object({
  subject: z.string().max(200).optional(),
  body: z.string().max(10_000).optional(),
  html: z.string().max(50_000).optional().nullable(),
  vars: z.record(z.unknown()).optional(),
});

const testEmailBody = z.object({
  recipient: z.string().email(),
  subject: z.string().max(200).optional(),
  body: z.string().max(10_000).optional(),
});

const alertSettingsBody = z.object({
  recipients: z.array(z.string().email()).max(10),
  events: z.record(z.boolean()),
});

const SAMPLE_VARS: Record<string, unknown> = {
  storeName: "Kash Commerce",
  customerName: "Jane Doe",
  customerEmail: "jane@example.com",
  customerPhone: "+1 (555) 019-2834",
  name: "Jane",
  orderNumber: "ORD-2026-0001",
  orderTotal: "129.00",
  total: "129.00",
  currency: "USD",
  trackingNumber: "TRK-9876543210",
  trackingUrl: "https://track.example.com/TRK-9876543210",
  courierName: "Standard Express",
  accountUrl: "https://store.example.com/account",
  supportEmail: "support@example.com",
  link: "https://store.example.com/verify?token=example_token_12345",
  code: "847291",
  status: "CONFIRMED",
  amount: "49.00",
  date: "2026-10-28",
  itemCount: 2,
  paymentMethod: "Card",
  paymentStatus: "PAID",
  shippingAddress: "123 Market St, Suite 400, San Francisco, CA 94103",
  itemsSummary: "2x Classic Tee (Black / L)",
  adminOrderUrl: "https://admin.example.com/orders/ord_123",
};

export function register(ctx: AppContext): ModuleRoutes {
  const admin = Router();

  // ───────── Templates Management ─────────

  admin.get(
    "/notifications/templates",
    requirePermission("settings.read"),
    h(async (_req, res) => {
      const overrides = await ctx.prisma.notificationTemplate.findMany({
        where: { channel: "EMAIL" },
      });
      const overrideMap = new Map(overrides.map((r) => [r.event, r]));

      const items = Object.entries(DEFAULT_TEMPLATES).map(([event, def]) => {
        const row = overrideMap.get(event);
        return {
          event,
          channel: "EMAIL",
          subject: row ? row.subject : def.subject,
          body: row ? row.body : def.body,
          html: row ? row.html : def.html ?? null,
          isEnabled: row ? row.isEnabled : true,
          isCustomized: !!row,
          description: def.description ?? "",
          updatedAt: row?.updatedAt ?? null,
        };
      });

      res.json({ items });
    }),
  );

  admin.get(
    "/notifications/templates/:event",
    requirePermission("settings.read"),
    h(async (req, res) => {
      const event = String(req.params.event);
      const def = DEFAULT_TEMPLATES[event];
      if (!def) throw AppError.notFound(`Template for event '${event}'`);

      const row = await ctx.prisma.notificationTemplate.findUnique({
        where: { event_channel: { event, channel: "EMAIL" } },
      });

      res.json({
        event,
        channel: "EMAIL",
        subject: row ? row.subject : def.subject,
        body: row ? row.body : def.body,
        html: row ? row.html : def.html ?? null,
        isEnabled: row ? row.isEnabled : true,
        isCustomized: !!row,
        description: def.description ?? "",
        defaultSubject: def.subject,
        defaultBody: def.body,
        updatedAt: row?.updatedAt ?? null,
      });
    }),
  );

  admin.put(
    "/notifications/templates/:event",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const event = String(req.params.event);
      const def = DEFAULT_TEMPLATES[event];
      if (!def) throw AppError.notFound(`Template for event '${event}'`);

      const b = parse(updateTemplateBody, req.body);

      // Security check: verify critical placeholders are not removed
      if (event === "customer.login_code" && !b.subject.includes("{{code}}") && !b.body.includes("{{code}}")) {
        throw AppError.validation("The login code email template must contain {{code}} in the subject or body.");
      }
      if (event === "password.reset" && !b.body.includes("{{link}}")) {
        throw AppError.validation("The password reset email template must contain {{link}} in the body.");
      }

      const before = await ctx.prisma.notificationTemplate.findUnique({
        where: { event_channel: { event, channel: "EMAIL" } },
      });

      const updated = await ctx.prisma.notificationTemplate.upsert({
        where: { event_channel: { event, channel: "EMAIL" } },
        create: {
          event,
          channel: "EMAIL",
          subject: b.subject,
          body: b.body,
          html: b.html ?? null,
          isEnabled: b.isEnabled,
        },
        update: {
          subject: b.subject,
          body: b.body,
          html: b.html ?? null,
          isEnabled: b.isEnabled,
        },
      });

      await audit(ctx, req, {
        action: "notification_template.update",
        entityType: "NotificationTemplate",
        entityId: updated.id,
        before,
        after: updated,
      });

      res.json(updated);
    }),
  );

  admin.post(
    "/notifications/templates/:event/preview",
    requirePermission("settings.read"),
    h(async (req, res) => {
      const event = String(req.params.event);
      const def = DEFAULT_TEMPLATES[event];
      if (!def) throw AppError.notFound(`Template for event '${event}'`);

      const b = parse(previewBody, req.body);
      const row = await ctx.prisma.notificationTemplate.findUnique({
        where: { event_channel: { event, channel: "EMAIL" } },
      });

      const tpl: TemplateDefinition = {
        subject: b.subject ?? row?.subject ?? def.subject,
        body: b.body ?? row?.body ?? def.body,
        html: b.html !== undefined ? (b.html ?? undefined) : row?.html ?? undefined,
      };

      const settings = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });
      const storeName = settings?.name ?? "Kash Commerce";
      const rawVars: Record<string, unknown> = {
        ...SAMPLE_VARS,
        storeName,
        supportEmail: settings?.supportEmail ?? "support@example.com",
        ...(b.vars ?? {}),
      };
      const vars: Record<string, string | number> = Object.fromEntries(
        Object.entries(rawVars).filter(([_, v]) => typeof v === "string" || typeof v === "number") as [string, string | number][],
      );

      const subject = render(tpl.subject, vars);
      const body = render(tpl.body, vars);
      const html = tpl.html
        ? render(tpl.html, vars)
        : renderHtmlEmail({
            storeName,
            supportEmail: settings?.supportEmail ?? undefined,
            heading: subject,
            bodyText: body,
            codeBox: typeof rawVars.code === "string" ? rawVars.code : undefined,
            actionButton:
              typeof rawVars.link === "string"
                ? { label: "Action Link", url: rawVars.link }
                : typeof rawVars.trackingUrl === "string"
                  ? { label: "Track Package", url: rawVars.trackingUrl }
                  : undefined,
          });

      res.json({ subject, body, html });
    }),
  );

  admin.post(
    "/notifications/templates/:event/test",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const event = String(req.params.event);
      const def = DEFAULT_TEMPLATES[event];
      if (!def) throw AppError.notFound(`Template for event '${event}'`);

      const b = parse(testEmailBody, req.body);
      const settings = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });

      await notify(
        ctx,
        event,
        b.recipient,
        {
          ...SAMPLE_VARS,
          storeName: settings?.name ?? "Store",
          name: b.recipient.split("@")[0],
          ...(b.subject ? { subject: b.subject } : {}),
          ...(b.body ? { body: b.body } : {}),
        },
        { force: true },
      );

      res.json({ ok: true, recipient: b.recipient });
    }),
  );

  admin.post(
    "/notifications/templates/:event/reset",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const event = String(req.params.event);
      const def = DEFAULT_TEMPLATES[event];
      if (!def) throw AppError.notFound(`Template for event '${event}'`);

      await ctx.prisma.notificationTemplate.deleteMany({
        where: { event, channel: "EMAIL" },
      });

      await audit(ctx, req, {
        action: "notification_template.reset",
        entityType: "NotificationTemplate",
        entityId: event,
      });

      res.json({ ok: true, reset: true });
    }),
  );

  // ───────── Notification Logs ─────────

  admin.get(
    "/notifications/logs",
    requirePermission("settings.read"),
    h(async (req, res) => {
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "25"), 10) || 25));
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const event = typeof req.query.event === "string" ? req.query.event : undefined;
      const recipient = typeof req.query.recipient === "string" ? req.query.recipient : undefined;

      const where = {
        ...(status ? { status } : {}),
        ...(event ? { event } : {}),
        ...(recipient ? { recipient: { contains: recipient, mode: "insensitive" as const } } : {}),
      };

      const [items, total] = await Promise.all([
        ctx.prisma.notificationLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        ctx.prisma.notificationLog.count({ where }),
      ]);

      res.json({
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    }),
  );

  admin.post(
    "/notifications/logs/:id/retry",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const id = String(req.params.id);
      const success = await retryNotification(ctx, id);
      if (!success) {
        throw new AppError(500, "PROVIDER_ERROR", "Failed to deliver retried notification.");
      }
      res.json({ ok: true });
    }),
  );

  // ───────── Admin Alerts Configuration ─────────

  admin.get(
    "/notifications/alerts",
    requirePermission("settings.read"),
    h(async (_req, res) => {
      const settings = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });
      const alerts = (settings?.adminAlerts ?? {}) as { recipients?: string[]; events?: Record<string, boolean> };
      res.json({
        recipients: Array.isArray(alerts.recipients) ? alerts.recipients : [],
        events: alerts.events ?? {
          new_order: true,
          payment_successful: true,
          payment_failed: true,
          cancelled: true,
          return_requested: true,
          shipped: false,
          out_for_delivery: false,
          delivered: false,
          refund_initiated: false,
          refund_completed: false,
        },
      });
    }),
  );

  admin.put(
    "/notifications/alerts",
    requirePermission("settings.write"),
    h(async (req, res) => {
      const b = parse(alertSettingsBody, req.body);
      const before = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });

      const updated = await ctx.prisma.storeSettings.update({
        where: { id: "store" },
        data: {
          adminAlerts: {
            recipients: b.recipients,
            events: b.events,
          },
        },
      });

      await audit(ctx, req, {
        action: "admin_alerts.update",
        entityType: "StoreSettings",
        entityId: "store",
        before: before?.adminAlerts,
        after: updated.adminAlerts,
      });

      res.json({ adminAlerts: updated.adminAlerts });
    }),
  );

  return { admin };
}
