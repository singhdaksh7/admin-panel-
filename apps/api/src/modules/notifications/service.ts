import nodemailer from "nodemailer";
import type { NotificationProvider } from "@kash-commerce/provider-sdk";
import type { Env } from "@kash-commerce/config";
import type { Logger } from "pino";
import type { AppContext } from "../../context";
import { renderHtmlEmail } from "./emailTemplate";

export interface TemplateDefinition {
  subject: string;
  body: string;
  html?: string;
  description?: string;
}

/** Default templates; admins can override per event via NotificationTemplate rows. */
export const DEFAULT_TEMPLATES: Record<string, TemplateDefinition> = {
  "customer.welcome": {
    subject: "Welcome to {{storeName}}",
    body: "Hi {{name}},\n\nThanks for creating an account at {{storeName}}. You can manage your orders and shipping addresses anytime at {{accountUrl}}.",
    description: "Sent to new customers upon account creation.",
  },
  "customer.login_code": {
    subject: "Your login code for {{storeName}}: {{code}}",
    body: "Hi {{name}},\n\nYour one-time login code is {{code}}.\n\nThis code will expire in 10 minutes. If you did not request this login code, you can safely ignore this email.",
    description: "Sent to customers requesting passwordless / email OTP login.",
  },
  "customer.verify": {
    subject: "Confirm your email address - {{storeName}}",
    body: "Hi {{name}},\n\nConfirm your email address to link your previous orders:\n{{link}}\n\nThe link is valid for 3 days.",
    description: "Sent when email verification is requested.",
  },
  "order.confirmation": {
    subject: "Order {{orderNumber}} confirmed - {{storeName}}",
    body: "Hi {{name}},\n\nThank you for your order! We have received order {{orderNumber}} totalling {{total}} {{currency}}.\n\nWe will notify you as soon as your items are on the way.",
    description: "Sent to customer immediately upon order confirmation.",
  },
  "order.processing": {
    subject: "Order {{orderNumber}} is being prepared - {{storeName}}",
    body: "Hi {{name}},\n\nGood news! Your order {{orderNumber}} is now being prepared for packing and dispatch.",
    description: "Sent when an order moves into processing.",
  },
  "order.shipped": {
    subject: "Your order {{orderNumber}} has shipped!",
    body: "Hi {{name}},\n\nYour order {{orderNumber}} is on its way with {{courierName}}.\nTracking number: {{trackingNumber}}\nTrack your parcel here: {{trackingUrl}}",
    description: "Sent when an order has been shipped.",
  },
  "order.in_transit": {
    subject: "Update: Order {{orderNumber}} is in transit",
    body: "Hi {{name}},\n\nYour order {{orderNumber}} is moving through the courier network. Tracking: {{trackingUrl}}",
    description: "Sent for meaningful in-transit courier milestones.",
  },
  "order.out_for_delivery": {
    subject: "Out for delivery: Order {{orderNumber}} arrives today!",
    body: "Hi {{name}},\n\nYour parcel for order {{orderNumber}} is out for delivery today. Please ensure someone is available at the delivery address.",
    description: "Sent when courier marks order out for delivery.",
  },
  "order.delivered": {
    subject: "Delivered: Order {{orderNumber}} has arrived",
    body: "Hi {{name}},\n\nYour order {{orderNumber}} has been delivered. We hope you love your purchase! If you need any assistance, reach out at {{supportEmail}}.",
    description: "Sent when delivery is successfully confirmed.",
  },
  "order.delivery_failed": {
    subject: "Delivery issue with order {{orderNumber}}",
    body: "Hi {{name}},\n\nA delivery attempt for order {{orderNumber}} was unsuccessful. Please check tracking at {{trackingUrl}} or contact us at {{supportEmail}} to reschedule.",
    description: "Sent when a delivery attempt fails.",
  },
  "order.cancelled": {
    subject: "Order {{orderNumber}} has been cancelled",
    body: "Hi {{name}},\n\nOrder {{orderNumber}} has been cancelled. If payment was already completed, any applicable refund will be processed to your original payment method.",
    description: "Sent when an order is cancelled.",
  },
  "password.reset": {
    subject: "Reset your password - {{storeName}}",
    body: "Hi {{name}},\n\nUse this link to reset your password (valid for 1 hour):\n{{link}}\n\nIf you did not request this, ignore this email.",
    description: "Sent when password reset is requested.",
  },
  "order.status": {
    subject: "Order {{orderNumber}} is now {{status}} - {{storeName}}",
    body: "Hi {{name}},\n\nYour order {{orderNumber}} status changed to {{status}}.",
    description: "Sent on generic order status transition.",
  },
  "return.update": {
    subject: "Return update for order {{orderNumber}} - {{storeName}}",
    body: "Hi {{name}},\n\nYour return for order {{orderNumber}} is now {{status}}.",
    description: "Sent when return status changes.",
  },
  "refund.processed": {
    subject: "Refund processed for order {{orderNumber}}",
    body: "Hi {{name}},\n\nA refund of {{amount}} {{currency}} was issued for order {{orderNumber}}.",
    description: "Sent when a refund is marked processed.",
  },
  "refund.initiated": {
    subject: "Refund initiated for order {{orderNumber}}",
    body: "Hi {{name}},\n\nA refund of {{amount}} {{currency}} has been initiated for order {{orderNumber}}. It typically takes 3-7 business days to reflect on your statement.",
    description: "Sent when a refund is initiated.",
  },
  "refund.completed": {
    subject: "Refund processed for order {{orderNumber}}",
    body: "Hi {{name}},\n\nA refund of {{amount}} {{currency}} was successfully completed for order {{orderNumber}}.",
    description: "Sent when a refund is marked processed.",
  },
  // Internal admin notification templates
  "admin.new_order": {
    subject: "[Admin Alert] New Order {{orderNumber}} - {{total}} {{currency}}",
    body: "A new order {{orderNumber}} was placed on {{storeName}}.\n\nCustomer: {{customerName}} ({{customerEmail}})\nTotal: {{total}} {{currency}}\nPayment: {{paymentMethod}} ({{paymentStatus}})\nDestination: {{shippingAddress}}\n\nView order: {{adminOrderUrl}}",
    description: "Internal alert sent to administrators on new order placement.",
  },
  "admin.payment_successful": {
    subject: "[Admin Alert] Payment successful for order {{orderNumber}}",
    body: "Payment for order {{orderNumber}} was successfully captured.\nCustomer: {{customerName}} ({{customerEmail}})\nTotal: {{total}} {{currency}}\nPayment: {{paymentMethod}}",
    description: "Internal alert sent when payment succeeds.",
  },
  "admin.payment_failed": {
    subject: "[Admin Alert] Payment failed for order {{orderNumber}}",
    body: "Payment for order {{orderNumber}} failed.\nCustomer: {{customerName}} ({{customerEmail}})\nAmount: {{total}} {{currency}}\nReason: {{status}}",
    description: "Internal alert sent when a payment fails.",
  },
  "admin.cancelled": {
    subject: "[Admin Alert] Order {{orderNumber}} cancelled",
    body: "Order {{orderNumber}} has been cancelled.",
    description: "Internal alert sent when an order is cancelled.",
  },
  "admin.shipped": {
    subject: "[Admin Alert] Order {{orderNumber}} shipped",
    body: "Order {{orderNumber}} has been shipped with {{courierName}} (Tracking: {{trackingNumber}}).",
    description: "Internal alert sent when an order ships.",
  },
  "admin.out_for_delivery": {
    subject: "[Admin Alert] Order {{orderNumber}} out for delivery",
    body: "Order {{orderNumber}} is out for delivery today.",
    description: "Internal alert sent when an order is out for delivery.",
  },
  "admin.delivered": {
    subject: "[Admin Alert] Order {{orderNumber}} delivered",
    body: "Order {{orderNumber}} was successfully delivered.",
    description: "Internal alert sent when an order is delivered.",
  },
  "admin.return_requested": {
    subject: "[Admin Alert] Return requested for order {{orderNumber}}",
    body: "Customer {{customerName}} requested a return for order {{orderNumber}}.\nView details in the admin portal.",
    description: "Internal alert sent when a customer files a return request.",
  },
  "admin.refund_initiated": {
    subject: "[Admin Alert] Refund initiated for order {{orderNumber}}",
    body: "A refund of {{amount}} {{currency}} has been initiated for order {{orderNumber}}.",
    description: "Internal alert sent when a refund is initiated.",
  },
  "admin.refund_completed": {
    subject: "[Admin Alert] Refund completed for order {{orderNumber}}",
    body: "A refund of {{amount}} {{currency}} was completed for order {{orderNumber}}.",
    description: "Internal alert sent when a refund is completed.",
  },
};

/** Allowlisted placeholders to prevent arbitrary template injections */
export const ALLOWED_PLACEHOLDERS = new Set([
  "storeName",
  "customerName",
  "customerEmail",
  "customerPhone",
  "name",
  "orderNumber",
  "orderTotal",
  "total",
  "currency",
  "trackingNumber",
  "trackingUrl",
  "courierName",
  "accountUrl",
  "supportEmail",
  "link",
  "code",
  "status",
  "amount",
  "date",
  "itemCount",
  "paymentMethod",
  "paymentStatus",
  "shippingAddress",
  "itemsSummary",
  "adminOrderUrl",
]);

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => {
    if (!ALLOWED_PLACEHOLDERS.has(k)) return "";
    return String(vars[k] ?? "");
  });
}

export function createLogEmailProvider(logger: Logger): NotificationProvider {
  return {
    channel: "EMAIL",
    async send(m) {
      logger.info({ to: m.to, subject: m.subject }, "email (LOG provider)");
    },
  };
}

export function createSmtpEmailProvider(env: Env): NotificationProvider {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return {
    channel: "EMAIL",
    async send(m) {
      await transport.sendMail({
        from: env.EMAIL_FROM,
        to: m.to,
        subject: m.subject,
        text: m.body,
        html: m.html,
      });
    },
  };
}

export interface NotifyOptions {
  deduplicationKey?: string;
  force?: boolean;
}

/** Fire-and-forget safe notification. Never throws into the caller. */
export async function notify(
  ctx: AppContext,
  event: string,
  to: string,
  vars: Record<string, unknown>,
  opts: NotifyOptions = {},
): Promise<void> {
  try {
    const settings = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });
    const row = await ctx.prisma.notificationTemplate.findUnique({
      where: { event_channel: { event, channel: "EMAIL" } },
    });
    if (row && !row.isEnabled) {
      await ctx.prisma.notificationLog.create({
        data: {
          event,
          channel: "EMAIL",
          recipient: to,
          status: "SKIPPED",
          payload: vars as object,
        },
      });
      return;
    }

    // Deduplication check: if deduplicationKey is provided, skip if sent in last 24h
    if (opts.deduplicationKey && !opts.force) {
      const recent = await ctx.prisma.notificationLog.findFirst({
        where: {
          event,
          recipient: to,
          status: "SENT",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          payload: { path: ["deduplicationKey"], equals: opts.deduplicationKey },
        },
      });
      if (recent) {
        ctx.logger.info({ event, to, deduplicationKey: opts.deduplicationKey }, "duplicate notification suppressed");
        return;
      }
    }

    const tpl = row ?? DEFAULT_TEMPLATES[event];
    if (!tpl) {
      ctx.logger.warn({ event }, "no template defined for notification event");
      return;
    }

    const storeName = settings?.name ?? "Store";
    const supportEmail = settings?.supportEmail ?? undefined;
    const base = ctx.env.CORS_ORIGINS[0] ?? ctx.env.PUBLIC_API_URL;
    const accountUrl = `${base}/account`;

    const allVars: Record<string, unknown> = {
      storeName,
      supportEmail,
      accountUrl,
      name: to.split("@")[0],
      customerName: to.split("@")[0],
      ...vars,
      ...(opts.deduplicationKey ? { deduplicationKey: opts.deduplicationKey } : {}),
    };

    const subject = render(tpl.subject, allVars);
    const body = render(tpl.body, allVars);

    // Resolve HTML email
    let html: string;
    if (tpl.html && tpl.html.trim().length > 0) {
      html = render(tpl.html, allVars);
    } else {
      html = renderHtmlEmail({
        storeName,
        supportEmail,
        heading: subject,
        bodyText: body,
        codeBox: typeof vars.code === "string" ? vars.code : undefined,
        actionButton:
          typeof vars.link === "string"
            ? { label: event.includes("password") ? "Reset Password" : "Confirm Email", url: vars.link }
            : typeof vars.trackingUrl === "string"
              ? { label: "Track Package", url: vars.trackingUrl }
              : undefined,
      });
    }

    const provider = ctx.providers.notification[ctx.providers.activeNotification];
    if (!provider) {
      ctx.logger.warn({ active: ctx.providers.activeNotification }, "active notification provider not found");
      return;
    }

    await provider.send({ to, subject, body, html });

    await ctx.prisma.notificationLog.create({
      data: {
        event,
        channel: "EMAIL",
        recipient: to,
        status: "SENT",
        payload: allVars as object,
        lastAttemptAt: new Date(),
      },
    });
  } catch (err) {
    ctx.logger.error({ err, event, to }, "notification send failed");
    await ctx.prisma.notificationLog
      .create({
        data: {
          event,
          channel: "EMAIL",
          recipient: to,
          status: "FAILED",
          error: String((err as Error).message).slice(0, 300),
          payload: vars as object,
          lastAttemptAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}

/** Retries a failed notification log entry. */
export async function retryNotification(ctx: AppContext, logId: string): Promise<boolean> {
  const log = await ctx.prisma.notificationLog.findUnique({ where: { id: logId } });
  if (!log || log.status === "SENT") return false;

  const payload = (log.payload ?? {}) as Record<string, unknown>;
  const provider = ctx.providers.notification[ctx.providers.activeNotification];
  if (!provider) return false;

  const settings = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });
  const row = await ctx.prisma.notificationTemplate.findUnique({
    where: { event_channel: { event: log.event, channel: "EMAIL" } },
  });
  const tpl = row ?? DEFAULT_TEMPLATES[log.event];
  if (!tpl) return false;

  const storeName = settings?.name ?? "Store";
  const allVars = { storeName, ...payload };
  const subject = render(tpl.subject, allVars);
  const body = render(tpl.body, allVars);

  const html = tpl.html
    ? render(tpl.html, allVars)
    : renderHtmlEmail({
        storeName,
        supportEmail: settings?.supportEmail ?? undefined,
        heading: subject,
        bodyText: body,
      });

  try {
    await provider.send({ to: log.recipient, subject, body, html });
    await ctx.prisma.notificationLog.update({
      where: { id: logId },
      data: {
        status: "SENT",
        error: null,
        retryCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    return true;
  } catch (err) {
    await ctx.prisma.notificationLog.update({
      where: { id: logId },
      data: {
        status: "FAILED",
        error: String((err as Error).message).slice(0, 300),
        retryCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    return false;
  }
}

export interface AdminAlertSettings {
  recipients: string[];
  events: Record<string, boolean>;
}

/** Dispatches internal notification email to configured store administrators. */
export async function notifyAdmin(
  ctx: AppContext,
  event: "new_order" | "payment_successful" | "payment_failed" | "cancelled" | "shipped" | "out_for_delivery" | "delivered" | "return_requested" | "refund_initiated" | "refund_completed",
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const settings = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });
    const alerts = (settings?.adminAlerts ?? {}) as Partial<AdminAlertSettings>;
    const recipients = Array.isArray(alerts.recipients) ? alerts.recipients.filter((r) => r && r.includes("@")) : [];
    if (recipients.length === 0) return;

    // Check if event is enabled (high-value events default to enabled)
    const defaultEnabled = ["new_order", "payment_successful", "payment_failed", "cancelled", "return_requested"].includes(event);
    const isEnabled = alerts.events?.[event] ?? defaultEnabled;
    if (!isEnabled) return;

    const eventName = `admin.${event}`;
    const orderNumber = String(data.orderNumber ?? "");
    for (const recipient of recipients) {
      await notify(
        ctx,
        eventName,
        recipient,
        data,
        { deduplicationKey: orderNumber ? `admin:${event}:${orderNumber}` : undefined },
      );
    }
  } catch (err) {
    ctx.logger.error({ err, event }, "admin alert dispatch failed");
  }
}
