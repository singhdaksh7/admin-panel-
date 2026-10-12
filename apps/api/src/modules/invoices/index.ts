import { Router, type Response } from "express";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { requirePermission } from "../../middleware/adminAuth";
import { customerAuth } from "../../middleware/customerAuth";
import { loadAccessibleOrder } from "../payments/access";
import { getOrCreateInvoice, invoiceDto, renderInvoicePdf, type InvoiceSnapshot } from "./service";

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const pub = Router();
  const admin = Router();
  const opt = customerAuth(ctx, { required: false });
  const authed = customerAuth(ctx, { required: true });

  async function sendPdf(res: Response, orderId: string) {
    const inv = await getOrCreateInvoice(ctx, orderId);
    const pdf = await renderInvoicePdf(inv.data as unknown as InvoiceSnapshot);
    res
      .status(200)
      .set({
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.length),
        "Content-Disposition": `attachment; filename="${inv.invoiceNumber}.pdf"`,
        "Cache-Control": "private, no-store",
      })
      .end(pdf);
  }

  // ───────── admin ─────────
  const findOrder = async (idOrNumber: string) => {
    const o = await p.order.findFirst({
      where: { OR: [{ id: idOrNumber }, { orderNumber: idOrNumber }] },
      select: { id: true },
    });
    if (!o) throw AppError.notFound("Order");
    return o;
  };

  admin.get(
    "/orders/:id/invoice",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const o = await findOrder(id);
      const before = await p.invoice.findUnique({ where: { orderId: o.id }, select: { id: true } });
      const inv = await getOrCreateInvoice(ctx, o.id);
      if (!before)
        await audit(ctx, req, {
          action: "invoice.generate",
          entityType: "Invoice",
          entityId: inv.id,
          extra: { orderId: o.id, invoiceNumber: inv.invoiceNumber },
        });
      res.json(invoiceDto(inv));
    }),
  );

  admin.get(
    "/orders/:id/invoice.pdf",
    requirePermission("orders.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const o = await findOrder(id);
      await sendPdf(res, o.id);
    }),
  );

  // ───────── customer / guest ─────────
  pub.get(
    "/account/orders/:orderNumber/invoice.pdf",
    authed,
    h(async (req, res) => {
      const o = await p.order.findFirst({
        where: {
          orderNumber: String(req.params.orderNumber).slice(0, 40),
          customerId: req.customer!.id,
        },
        select: { id: true },
      });
      if (!o) throw AppError.notFound("Order");
      await sendPdf(res, o.id);
    }),
  );

  pub.get(
    "/orders/:orderNumber/invoice.pdf",
    limiters.checkout,
    opt,
    h(async (req, res) => {
      const email = typeof req.query.email === "string" ? req.query.email : undefined;
      const o = await loadAccessibleOrder(p, req, String(req.params.orderNumber), email);
      await sendPdf(res, o.id);
    }),
  );

  return { public: pub, admin };
}
