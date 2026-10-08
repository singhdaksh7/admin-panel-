import nodemailer from "nodemailer";
import type { NotificationProvider } from "@kash-commerce/provider-sdk";
import type { Env } from "@kash-commerce/config";
import type { Logger } from "pino";
import type { AppContext } from "../../context";

/** Default templates; admins can override per event via NotificationTemplate rows. */
export const DEFAULT_TEMPLATES: Record<string, { subject: string; body: string }> = {
  "customer.welcome": {
    subject: "Welcome to {{storeName}}",
    body: "Hi {{name}},\n\nThanks for creating an account at {{storeName}}.",
  },
  "order.confirmation": {
    subject: "Order {{orderNumber}} confirmed",
    body: "Hi {{name}},\n\nWe received your order {{orderNumber}} totalling {{total}} {{currency}}.",
  },
  "order.status": {
    subject: "Order {{orderNumber}} is now {{status}}",
    body: "Hi {{name}},\n\nYour order {{orderNumber}} status changed to {{status}}.",
  },
  "order.shipped": {
    subject: "Order {{orderNumber}} has shipped",
    body: "Hi {{name}},\n\nYour order {{orderNumber}} is on its way. Tracking: {{trackingUrl}}",
  },
  "password.reset": {
    subject: "Reset your password",
    body: "Use this link to reset your password (valid for 1 hour):\n{{link}}\n\nIf you did not request this, ignore this email.",
  },
  "return.update": {
    subject: "Return update for order {{orderNumber}}",
    body: "Hi {{name}},\n\nYour return for order {{orderNumber}} is now {{status}}.",
  },
  "refund.processed": {
    subject: "Refund processed for order {{orderNumber}}",
    body: "Hi {{name}},\n\nA refund of {{amount}} {{currency}} was issued for order {{orderNumber}}.",
  },
};

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => String(vars[k] ?? ""));
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

/** Fire-and-forget safe notification. Never throws into the caller. */
export async function notify(
  ctx: AppContext,
  event: string,
  to: string,
  vars: Record<string, unknown>,
): Promise<void> {
  try {
    const settings = await ctx.prisma.storeSettings.findUnique({ where: { id: "store" } });
    const row = await ctx.prisma.notificationTemplate.findUnique({
      where: { event_channel: { event, channel: "EMAIL" } },
    });
    if (row && !row.isEnabled) {
      await ctx.prisma.notificationLog.create({
        data: { event, channel: "EMAIL", recipient: to, status: "SKIPPED" },
      });
      return;
    }
    const tpl = row ?? DEFAULT_TEMPLATES[event];
    if (!tpl) return;
    const all = { storeName: settings?.name ?? "Store", ...vars };
    const provider = ctx.providers.notification[ctx.providers.activeNotification];
    if (!provider) return;
    await provider.send({ to, subject: render(tpl.subject, all), body: render(tpl.body, all) });
    await ctx.prisma.notificationLog.create({
      data: { event, channel: "EMAIL", recipient: to, status: "SENT" },
    });
  } catch (err) {
    ctx.logger.error({ err, event }, "notification failed");
    await ctx.prisma.notificationLog
      .create({
        data: {
          event,
          channel: "EMAIL",
          recipient: to,
          status: "FAILED",
          error: String((err as Error).message).slice(0, 300),
        },
      })
      .catch(() => undefined);
  }
}
