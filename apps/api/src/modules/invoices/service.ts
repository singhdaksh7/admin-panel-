/**
 * INVOICE SERVICE
 *
 *   getOrCreateInvoice(ctx, orderId): Promise<Invoice>
 *       Idempotent (unique orderId). Allowed once the order is CONFIRMED or later and not CANCELLED (409 else).
 *       Number = `${prefix}-${year}-${000001}`; the counter is a single guarded UPDATE on InvoiceSequence inside
 *       the same transaction (gap-free, race-safe). The snapshot (Invoice.data) is immutable: PDFs are rendered
 *       from it only, never from live product/store data.
 *   renderInvoicePdf(snapshot, invoiceNumber): Promise<Buffer>
 */
import PDFDocument from "pdfkit";
import type { Invoice, Prisma } from "@kash-commerce/database";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";

export interface InvoiceLine {
  description: string;
  sku: string;
  hsn: string | null;
  qty: number;
  unitPrice: string;
  discount: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
}
export interface InvoiceAddress {
  name?: string;
  phone?: string | null;
  line1?: string;
  line2?: string | null;
  city?: string;
  state?: string | null;
  postalCode?: string;
  country?: string;
}
export interface InvoiceSnapshot {
  invoiceNumber: string;
  orderNumber: string;
  issuedAt: string;
  currency: string;
  locale: string;
  paymentStatus: string;
  seller: {
    name: string;
    legalName: string | null;
    address: Record<string, unknown> | null;
    gstin: string | null;
    email: string | null;
    phone: string | null;
  };
  buyer: { name: string; email: string; phone: string | null };
  shippingAddress: InvoiceAddress;
  billingAddress: InvoiceAddress;
  lines: InvoiceLine[];
  totals: { subtotal: string; discount: string; shipping: string; tax: string; total: string };
  taxBreakdown: unknown;
}

const NOT_INVOICEABLE = ["PENDING", "CANCELLED"];

export async function getOrCreateInvoice(ctx: AppContext, orderId: string): Promise<Invoice> {
  const existing = await ctx.prisma.invoice.findUnique({ where: { orderId } });
  if (existing) return existing;
  try {
    return await ctx.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const again = await tx.invoice.findUnique({ where: { orderId } });
        if (again) return again;
        const o = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
        if (!o) throw AppError.notFound("Order");
        if (NOT_INVOICEABLE.includes(o.status))
          throw AppError.conflict(`An invoice cannot be issued for a ${o.status} order`);
        const s = await tx.storeSettings.upsert({
          where: { id: "store" },
          create: { id: "store" },
          update: {},
        });
        const checkout = (s.checkout ?? {}) as { invoicePrefix?: string };
        const prefix =
          (checkout.invoicePrefix ?? "INV").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "INV";
        const issuedAt = new Date();
        const year = issuedAt.getUTCFullYear();
        await tx.$executeRaw`INSERT INTO "InvoiceSequence" ("id", "year", "value") VALUES ('invoice', ${year}, 0) ON CONFLICT ("id") DO NOTHING`;
        const rows = await tx.$queryRaw<{ value: number }[]>`
          UPDATE "InvoiceSequence"
             SET "value" = CASE WHEN "year" = ${year} THEN "value" + 1 ELSE 1 END, "year" = ${year}
           WHERE "id" = 'invoice' RETURNING "value"`;
        const invoiceNumber = `${prefix}-${year}-${String(rows[0]!.value).padStart(6, "0")}`;

        const tax = (s.tax ?? {}) as { gstin?: string };
        const cust = (o.customerSnapshot ?? {}) as { name?: string; phone?: string | null };
        const snapshot: InvoiceSnapshot = {
          invoiceNumber,
          orderNumber: o.orderNumber,
          issuedAt: issuedAt.toISOString(),
          currency: o.currency,
          locale: s.locale,
          paymentStatus: o.paymentStatus,
          seller: {
            name: s.name,
            legalName: s.legalName,
            address: (s.address ?? null) as Record<string, unknown> | null,
            gstin: tax.gstin ?? null,
            email: s.supportEmail,
            phone: s.phone,
          },
          buyer: { name: cust.name ?? "", email: o.email, phone: cust.phone ?? null },
          shippingAddress: (o.shippingAddress ?? {}) as InvoiceAddress,
          billingAddress: (o.billingAddress ?? {}) as InvoiceAddress,
          lines: o.items.map((i) => ({
            description: i.variantTitle ? `${i.productTitle} - ${i.variantTitle}` : i.productTitle,
            sku: i.sku,
            hsn: i.hsnCode,
            qty: i.quantity,
            unitPrice: i.unitPrice.toFixed(2),
            discount: i.discount.toFixed(2),
            taxRate: i.taxRate.toString(),
            taxAmount: i.taxAmount.toFixed(2),
            lineTotal: i.lineTotal.toFixed(2),
          })),
          totals: {
            subtotal: o.subtotal.toFixed(2),
            discount: o.discountTotal.toFixed(2),
            shipping: o.shippingTotal.toFixed(2),
            tax: o.taxTotal.toFixed(2),
            total: o.total.toFixed(2),
          },
          taxBreakdown: o.taxBreakdown ?? null,
        };
        return tx.invoice.create({
          data: {
            orderId,
            invoiceNumber,
            issuedAt,
            data: snapshot as unknown as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: 15000 },
    );
  } catch (err) {
    // lost a race on the unique orderId constraint: return the winner's invoice
    if ((err as { code?: string }).code === "P2002") {
      const won = await ctx.prisma.invoice.findUnique({ where: { orderId } });
      if (won) return won;
    }
    throw err;
  }
}

export function invoiceDto(i: Invoice) {
  return {
    id: i.id,
    orderId: i.orderId,
    invoiceNumber: i.invoiceNumber,
    issuedAt: i.issuedAt,
    data: i.data,
  };
}

function money(snap: InvoiceSnapshot) {
  let fmt: Intl.NumberFormat;
  try {
    // currency CODE (not symbol): the built-in PDF fonts cannot render glyphs such as the rupee sign
    fmt = new Intl.NumberFormat(snap.locale, {
      style: "currency",
      currency: snap.currency,
      currencyDisplay: "code",
    });
  } catch {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      currencyDisplay: "code",
    });
  }
  return (v: string) => fmt.format(Number(v)).replace(/[  ]/g, " ");
}

function addressLines(a: InvoiceAddress | Record<string, unknown> | null | undefined): string[] {
  if (!a) return [];
  const x = a as Record<string, string | null | undefined>;
  return [
    x.name,
    x.line1,
    x.line2,
    [x.city, x.state, x.postalCode].filter(Boolean).join(", "),
    x.country,
    x.phone ? `Phone: ${x.phone}` : undefined,
  ].filter((l): l is string => !!l && l.trim().length > 0);
}

/** Renders the invoice PDF from the stored snapshot only. */
export function renderInvoicePdf(snap: InvoiceSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: snap.invoiceNumber } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const fmt = money(snap);
    const left = 40;
    const right = doc.page.width - 40;
    const width = right - left;

    // header
    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .text(snap.seller.legalName || snap.seller.name, left, 40);
    doc.font("Helvetica").fontSize(9).fillColor("#444444");
    for (const l of addressLines(snap.seller.address)) doc.text(l);
    if (snap.seller.gstin) doc.text(`GSTIN: ${snap.seller.gstin}`);
    if (snap.seller.email) doc.text(snap.seller.email);
    if (snap.seller.phone) doc.text(snap.seller.phone);
    doc.fillColor("#000000");
    doc
      .font("Helvetica-Bold")
      .fontSize(16)
      .text("TAX INVOICE", left, 40, { width, align: "right" });
    doc.font("Helvetica").fontSize(10);
    doc.text(`Invoice no: ${snap.invoiceNumber}`, { width, align: "right" });
    doc.text(`Order no: ${snap.orderNumber}`, { width, align: "right" });
    doc.text(`Date: ${new Date(snap.issuedAt).toISOString().slice(0, 10)}`, {
      width,
      align: "right",
    });
    doc.text(`Payment: ${snap.paymentStatus}`, { width, align: "right" });

    // addresses
    let y = Math.max(doc.y, 150) + 16;
    doc.font("Helvetica-Bold").fontSize(10).text("Bill to", left, y);
    doc.text("Ship to", left + width / 2, y);
    doc.font("Helvetica").fontSize(9);
    const bill = [
      snap.buyer.name || undefined,
      ...addressLines({ ...snap.billingAddress, name: undefined, phone: undefined }),
      snap.buyer.email,
    ].filter((l): l is string => !!l);
    const ship = addressLines(snap.shippingAddress);
    const top = y + 14;
    doc.text(bill.join("\n"), left, top, { width: width / 2 - 10 });
    const billBottom = doc.y;
    doc.text(ship.join("\n"), left + width / 2, top, { width: width / 2 - 10 });
    y = Math.max(billBottom, doc.y) + 18;

    // table
    const cols = [
      { key: "description", label: "Item", w: 170, align: "left" as const },
      { key: "hsn", label: "HSN", w: 45, align: "left" as const },
      { key: "qty", label: "Qty", w: 30, align: "right" as const },
      { key: "unitPrice", label: "Unit price", w: 70, align: "right" as const },
      { key: "discount", label: "Disc.", w: 55, align: "right" as const },
      { key: "tax", label: "Tax", w: 65, align: "right" as const },
      { key: "lineTotal", label: "Total", w: 80, align: "right" as const },
    ];
    const scale = width / cols.reduce((s, c) => s + c.w, 0);
    for (const c of cols) c.w *= scale;
    const drawRow = (cells: string[], yy: number, bold: boolean, fill?: string) => {
      const heights = cells.map((t, i) =>
        doc
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(9)
          .heightOfString(t, { width: cols[i]!.w - 8 }),
      );
      const rowH = Math.max(...heights) + 8;
      if (fill) doc.rect(left, yy, width, rowH).fill(fill).fillColor("#000000");
      let x = left;
      cells.forEach((t, i) => {
        doc
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(9)
          .text(t, x + 4, yy + 4, {
            width: cols[i]!.w - 8,
            align: cols[i]!.align,
          });
        x += cols[i]!.w;
      });
      doc
        .moveTo(left, yy + rowH)
        .lineTo(right, yy + rowH)
        .strokeColor("#dddddd")
        .stroke();
      return yy + rowH;
    };
    y = drawRow(
      cols.map((c) => c.label),
      y,
      true,
      "#eeeeee",
    );
    for (const l of snap.lines) {
      if (y > doc.page.height - 160) {
        doc.addPage();
        y = 40;
        y = drawRow(
          cols.map((c) => c.label),
          y,
          true,
          "#eeeeee",
        );
      }
      y = drawRow(
        [
          l.sku ? `${l.description}\nSKU: ${l.sku}` : l.description,
          l.hsn ?? "-",
          String(l.qty),
          fmt(l.unitPrice),
          fmt(l.discount),
          `${fmt(l.taxAmount)}\n(${l.taxRate}%)`,
          fmt(l.lineTotal),
        ],
        y,
        false,
      );
    }

    // totals
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 40;
    }
    y += 14;
    const labelX = right - 230;
    const row = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 10);
      doc.text(label, labelX, y, { width: 110 });
      doc.text(value, labelX + 110, y, { width: 120, align: "right" });
      y += bold ? 18 : 15;
    };
    row("Subtotal", fmt(snap.totals.subtotal));
    if (Number(snap.totals.discount) > 0) row("Discount", `-${fmt(snap.totals.discount)}`);
    row("Shipping", fmt(snap.totals.shipping));
    const lines = (
      snap.taxBreakdown as { lines?: { name: string; rate: number; amount: string }[] } | null
    )?.lines;
    if (lines?.length) for (const t of lines) row(`${t.name} (${t.rate}%)`, fmt(t.amount));
    else row("Tax", fmt(snap.totals.tax));
    doc.moveTo(labelX, y).lineTo(right, y).strokeColor("#000000").stroke();
    y += 6;
    row("Total", fmt(snap.totals.total), true);

    doc.font("Helvetica").fontSize(8).fillColor("#666666");
    doc.text("This is a computer-generated invoice.", left, doc.page.height - 60, {
      width,
      align: "center",
    });
    doc.end();
  });
}
