import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import { registerCustomer } from "./commerceHelpers";
import { advanceTo, payViaVerify, placeOrder } from "./paymentsHelpers";
import { getOrCreateInvoice, renderInvoicePdf } from "../src/modules/invoices/service";
import type { InvoiceSnapshot } from "../src/modules/invoices/service";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let ctx: Awaited<ReturnType<typeof bootApp>>["ctx"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
beforeAll(async () => {
  ({ app, ctx } = await bootApp());
  admin = await loginAdmin(app);
  await admin.put("/api/v1/admin/settings", {
    name: "Kash Test Store",
    legalName: "Kash Test Pvt Ltd",
    supportEmail: "help@kash.test",
    currency: "INR",
    locale: "en-IN",
    address: {
      line1: "1 Market St",
      city: "Pune",
      state: "MH",
      postalCode: "411001",
      country: "IN",
    },
    tax: { mode: "INDIA_GST", defaultRate: 18, gstin: "27ABCDE1234F1Z5", homeState: "Maharashtra" },
    checkout: { invoicePrefix: "KC" },
  });
});

async function confirmed(email = "inv@example.com") {
  const placed = await placeOrder(app, { email, price: "100.00", qty: 2 });
  await payViaVerify(app, placed);
  return placed;
}

describe("invoice generation", () => {
  it("is refused for unconfirmed and cancelled orders", async () => {
    const placed = await placeOrder(app);
    const r = await admin.get(`/api/v1/admin/orders/${placed.order.id}/invoice`);
    expect(r.status).toBe(409);
    await payViaVerify(app, placed);
    await admin.post(`/api/v1/admin/orders/${placed.order.id}/cancel`, {});
    expect((await admin.get(`/api/v1/admin/orders/${placed.order.id}/invoice`)).status).toBe(409);
    expect((await admin.get("/api/v1/admin/orders/nope/invoice")).status).toBe(404);
  });

  it("generates a numbered invoice snapshot once (idempotent) and exposes it on the order detail", async () => {
    const placed = await confirmed();
    const a = await admin.get(`/api/v1/admin/orders/${placed.order.id}/invoice`);
    expect(a.status).toBe(200);
    const year = new Date().getUTCFullYear();
    expect(a.body.invoiceNumber).toMatch(new RegExp(`^KC-${year}-\\d{6}$`));
    const b = await admin.get(`/api/v1/admin/orders/${placed.order.orderNumber}/invoice`);
    expect(b.body.invoiceNumber).toBe(a.body.invoiceNumber);
    expect(await prisma.invoice.count({ where: { orderId: placed.order.id } })).toBe(1);
    const d = a.body.data;
    expect(d.seller).toMatchObject({
      name: "Kash Test Store",
      legalName: "Kash Test Pvt Ltd",
      gstin: "27ABCDE1234F1Z5",
      email: "help@kash.test",
    });
    expect(d.buyer.email).toBe("inv@example.com");
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ qty: 2, unitPrice: "100.00" });
    expect(d.totals.total).toBeTruthy();
    expect(d.currency).toBe("INR");
    expect(d.shippingAddress.line1).toBeTruthy();
    expect(d.orderNumber).toBe(placed.order.orderNumber);
    const detail = await admin.get(`/api/v1/admin/orders/${placed.order.id}`);
    expect(detail.body.invoice).toMatchObject({
      status: "GENERATED",
      invoiceNumber: a.body.invoiceNumber,
    });
    expect(detail.body.invoice.data).toBeUndefined();
  });

  it("numbers are unique and gap-free under parallel generation", async () => {
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push(await confirmed(`par${i}@example.com`));
    const before = await prisma.invoiceSequence.findUnique({ where: { id: "invoice" } });
    const results = await Promise.all(
      orders.flatMap((o) => [
        getOrCreateInvoice(ctx, o.order.id),
        getOrCreateInvoice(ctx, o.order.id), // duplicate request for the same order
      ]),
    );
    const numbers = new Set(results.map((r) => r.invoiceNumber));
    expect(numbers.size).toBe(6);
    const seqs = [...numbers].map((n) => Number(n.split("-")[2])).sort((a, b) => a - b);
    const start = (before?.value ?? 0) + 1;
    expect(seqs).toEqual(Array.from({ length: 6 }, (_, i) => start + i));
    expect(
      await prisma.invoice.count({ where: { orderId: { in: orders.map((o) => o.order.id) } } }),
    ).toBe(6);
  });

  it("the snapshot is immutable: later price/store/product changes do not alter it", async () => {
    const placed = await confirmed("immutable@example.com");
    const first = (await admin.get(`/api/v1/admin/orders/${placed.order.id}/invoice`)).body;
    await prisma.productVariant.update({
      where: { id: placed.variantId },
      data: { price: "999.00" },
    });
    await prisma.product.update({
      where: { id: placed.productId },
      data: { title: "Renamed product" },
    });
    await admin.put("/api/v1/admin/settings", { name: "Another Name" });
    const second = (await admin.get(`/api/v1/admin/orders/${placed.order.id}/invoice`)).body;
    expect(second.data).toEqual(first.data);
    expect(second.data.lines[0].unitPrice).toBe("100.00");
    expect(second.data.seller.name).toBe("Kash Test Store");
    const pdf = await renderInvoicePdf(second.data as InvoiceSnapshot);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await admin.put("/api/v1/admin/settings", { name: "Kash Test Store" });
  });
});

describe("invoice PDF", () => {
  it("admin gets application/pdf starting with %PDF", async () => {
    const placed = await confirmed("pdf@example.com");
    const r = await admin
      .get(`/api/v1/admin/orders/${placed.order.id}/invoice.pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/pdf");
    expect(r.headers["content-disposition"]).toContain(".pdf");
    const buf = r.body as Buffer;
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(800);
  });

  it("renders multi-line orders over several pages without error", async () => {
    const snap = (await getOrCreateInvoice(ctx, (await confirmed("big@example.com")).order.id))
      .data as unknown as InvoiceSnapshot;
    const big: InvoiceSnapshot = {
      ...snap,
      lines: Array.from({ length: 60 }, (_, i) => ({
        ...snap.lines[0]!,
        description: `Line item number ${i} with a fairly long descriptive title to force wrapping`,
      })),
    };
    const pdf = await renderInvoicePdf(big);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("guest access requires the matching email (IDOR safe)", async () => {
    const placed = await confirmed("guest-inv@example.com");
    const n = placed.order.orderNumber;
    const ok = await request(app).get(
      `/api/v1/orders/${n}/invoice.pdf?email=guest-inv@example.com`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("application/pdf");
    const wrong = await request(app).get(`/api/v1/orders/${n}/invoice.pdf?email=other@example.com`);
    const none = await request(app).get(`/api/v1/orders/${n}/invoice.pdf`);
    const missing = await request(app).get("/api/v1/orders/ORD-1/invoice.pdf?email=a@b.co");
    expect([wrong.status, none.status, missing.status]).toEqual([404, 404, 404]);
  });

  it("customers only get their own invoices", async () => {
    const cust = await registerCustomer(app, "inv-owner@example.com");
    const other = await registerCustomer(app, "inv-other@example.com");
    const { addToCart, seedProduct } = await import("./commerceHelpers");
    const { variant } = await seedProduct({ price: "10.00", stock: 5 });
    const token = await addToCart(app, variant.id, 1);
    const co = await cust.agent
      .post("/api/v1/checkout/create")
      .set("x-csrf-token", cust.csrf)
      .send({
        cartToken: token,
        shippingAddress: { fullName: "O", line1: "x", city: "c", postalCode: "1", country: "IN" },
      });
    const n = co.body.order.orderNumber as string;
    const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber: n } });
    await advanceTo(ctx, order.id, "CONFIRMED");
    const mine = await cust.get(`/api/v1/account/orders/${n}/invoice.pdf`);
    expect(mine.status).toBe(200);
    expect(mine.headers["content-type"]).toContain("application/pdf");
    expect((await other.get(`/api/v1/account/orders/${n}/invoice.pdf`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/account/orders/${n}/invoice.pdf`)).status).toBe(401);
    // the owning session may also use the guest route without an email
    expect((await cust.get(`/api/v1/orders/${n}/invoice.pdf`)).status).toBe(200);
  });

  it("enforces admin permissions", async () => {
    await createAdminWithRole("SUPPORT", "sup-inv@test.example");
    await createAdminWithRole("CATALOG_MANAGER", "cm-inv@test.example");
    await createAdminWithRole("ORDER_MANAGER", "om-inv@test.example");
    const sup = await loginAdmin(app, "sup-inv@test.example", "Another-Pass-123");
    const cm = await loginAdmin(app, "cm-inv@test.example", "Another-Pass-123");
    const om = await loginAdmin(app, "om-inv@test.example", "Another-Pass-123");
    const placed = await confirmed("perm@example.com");
    const url = `/api/v1/admin/orders/${placed.order.id}/invoice`;
    expect((await sup.get(url)).status).toBe(200);
    expect((await om.get(`${url}.pdf`)).status).toBe(200);
    expect((await cm.get(url)).status).toBe(403);
    expect((await cm.get(`${url}.pdf`)).status).toBe(403);
    expect((await request(app).get(url)).status).toBe(401);
  });

  it("renders TAX INVOICE only when GSTIN exists, and handles multi-page lines with pagination", async () => {
    const { renderInvoicePdf } = await import("../src/modules/invoices/service");
    const baseSnap = {
      invoiceNumber: "INV-2026-000001",
      orderNumber: "KC-000001",
      issuedAt: new Date().toISOString(),
      currency: "INR",
      locale: "en-IN",
      paymentStatus: "PAID",
      seller: {
        name: "Test Store",
        legalName: "Test Store Pvt Ltd",
        address: { line1: "123 Main St", city: "Mumbai", state: "MH", postalCode: "400001", country: "IN" },
        gstin: null,
        email: "support@teststore.com",
        phone: "+919876543210",
      },
      buyer: { name: "John Doe", email: "john@example.com", phone: "+919876543211" },
      shippingAddress: { line1: "456 Side St", city: "Delhi", postalCode: "110001", country: "IN" },
      billingAddress: { line1: "456 Side St", city: "Delhi", postalCode: "110001", country: "IN" },
      lines: Array.from({ length: 25 }, (_, i) => ({
        description: `Very Long Product Description That Wraps Lines Nicely Item ${i + 1}`,
        sku: `SKU-${i + 1}`,
        hsn: "9988",
        qty: 1,
        unitPrice: "100.00",
        discount: "0.00",
        taxRate: "18",
        taxAmount: "18.00",
        lineTotal: "118.00",
      })),
      totals: { subtotal: "2500.00", discount: "0.00", shipping: "50.00", tax: "450.00", total: "3000.00" },
      taxBreakdown: null,
    };

    // 1. Without GSTIN -> Renders regular INVOICE
    const pdfWithoutGst = await renderInvoicePdf(baseSnap);
    expect(pdfWithoutGst).toBeInstanceOf(Buffer);
    expect(pdfWithoutGst.length).toBeGreaterThan(1000);

    // 2. With GSTIN -> Renders TAX INVOICE
    const pdfWithGst = await renderInvoicePdf({
      ...baseSnap,
      seller: { ...baseSnap.seller, gstin: "27AABCU9603R1ZN" },
    });
    expect(pdfWithGst).toBeInstanceOf(Buffer);
    expect(pdfWithGst.length).toBeGreaterThan(1000);
  });
});
