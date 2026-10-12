import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN_PERMS, READ_ONLY_PERMS, callsTo, page, renderAt } from "./ops-helpers";
import { TRANSITIONS } from "../src/features/orders/OrderDetail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const addr = {
  fullName: "Asha Rao",
  line1: "1 MG Road",
  city: "Pune",
  state: "MH",
  postalCode: "411001",
  country: "IN",
  phone: "999",
};
const order = (status: string, extra: object = {}) => ({
  id: "o1",
  orderNumber: "ORD-100001",
  status,
  paymentStatus: "PAID",
  email: "asha@x.test",
  currency: "USD",
  customerSnapshot: { name: "Asha Rao", email: "asha@x.test" },
  customer: { id: "cu1", email: "asha@x.test", firstName: "Asha", lastName: "Rao" },
  subtotal: "100.00",
  discountTotal: "0.00",
  shippingTotal: "5.00",
  taxTotal: "18.00",
  total: "123.00",
  taxBreakdown: {
    mode: "GST",
    inclusive: false,
    lines: [
      { name: "CGST", rate: 9, amount: "9.00" },
      { name: "SGST", rate: 9, amount: "9.00" },
    ],
  },
  couponCode: null,
  shippingMethodName: "Standard",
  shippingAddress: addr,
  billingAddress: addr,
  paymentProvider: "razorpay",
  placedAt: "2026-02-01T10:00:00Z",
  items: [
    {
      id: "oi1",
      productTitle: "Linen Shirt",
      variantTitle: "Small",
      sku: "LS-S",
      imageUrl: null,
      unitPrice: "50.00",
      quantity: 2,
      discount: "0.00",
      taxRate: "18",
      taxAmount: "18.00",
      lineTotal: "118.00",
    },
  ],
  events: [
    {
      id: "e1",
      type: "STATUS_CHANGED",
      fromStatus: null,
      toStatus: "PENDING",
      message: "Order placed",
      actorType: "CUSTOMER",
      createdAt: "2026-02-01T10:00:00Z",
    },
  ],
  notes: [{ id: "n1", body: "Gift wrap please", createdAt: "2026-02-01T11:00:00Z" }],
  payments: [
    {
      id: "pay1",
      provider: "razorpay",
      status: "PAID",
      amount: "123.00",
      refundedAmount: "0.00",
      currency: "USD",
      providerPaymentId: "pp1",
      createdAt: "2026-02-01T10:01:00Z",
    },
  ],
  shipments: [],
  invoice: { status: "NOT_GENERATED" },
  ...extra,
});

describe("orders list", () => {
  it("applies filters from the URL and writes filter changes back", async () => {
    renderAt(
      "/orders?status=PENDING&paymentStatus=PAID&from=2026-01-01&sort=total&dir=asc",
      ADMIN_PERMS,
      {
        "GET /orders": {
          body: page([
            {
              id: "o1",
              orderNumber: "ORD-100001",
              status: "PENDING",
              paymentStatus: "PAID",
              email: "a@x.test",
              customer: "Asha",
              total: "10.00",
              currency: "USD",
              itemCount: 1,
              createdAt: "2026-02-01T10:00:00Z",
            },
          ]),
        },
      },
    );
    expect(await screen.findByText("ORD-100001")).toBeInTheDocument();
    const q = callsTo("GET", "/orders")[0]!.query;
    expect(q.get("status")).toBe("PENDING");
    expect(q.get("paymentStatus")).toBe("PAID");
    expect(q.get("sort")).toBe("total");
    expect(q.get("dir")).toBe("asc");
    expect(q.get("from")).toMatch(/^2026-01-01|^2025-12-31/);
    expect(screen.getByLabelText("Filter by status")).toHaveValue("PENDING");
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText("Filter by status"), "SHIPPED");
    await waitFor(() =>
      expect(callsTo("GET", "/orders").at(-1)!.query.get("status")).toBe("SHIPPED"),
    );
  });

  it("shows an empty state", async () => {
    renderAt("/orders", ADMIN_PERMS, { "GET /orders": { body: page([]) } });
    expect(await screen.findByText("No orders found")).toBeInTheDocument();
  });
});

describe("order detail", () => {
  it("only offers valid next statuses for the current status", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, { "GET /orders/o1": { body: order("CONFIRMED") } });
    expect(await screen.findByRole("heading", { name: "Order ORD-100001" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as processing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
    for (const bad of [
      "pending",
      "packed",
      "shipped",
      "delivered",
      "returned",
      "refunded",
      "confirmed",
    ])
      expect(screen.queryByRole("button", { name: `Mark as ${bad}` })).not.toBeInTheDocument();
    expect(TRANSITIONS.SHIPPED).toEqual(["DELIVERED", "RETURN_REQUESTED"]);
  });

  it("offers no actions for a cancelled order", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, { "GET /orders/o1": { body: order("CANCELLED") } });
    await screen.findByRole("heading", { name: "Order ORD-100001" });
    expect(screen.queryByRole("button", { name: /^Mark as/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
    expect(screen.getByText(/No further actions/)).toBeInTheDocument();
  });

  it("changes status with a confirm dialog and optional note", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, {
      "GET /orders/o1": { body: order("CONFIRMED") },
      "POST /orders/o1/status": { body: { id: "o1", status: "PROCESSING" } },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Mark as processing" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.type(dlg.getByLabelText(/Note/), "Picking now");
    await u.click(dlg.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(callsTo("POST", "/orders/o1/status")).toHaveLength(1));
    expect(callsTo("POST", "/orders/o1/status")[0]!.body).toEqual({
      status: "PROCESSING",
      note: "Picking now",
    });
  });

  it("cancels with a reason", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, {
      "GET /orders/o1": { body: order("PENDING") },
      "POST /orders/o1/cancel": { body: { id: "o1", status: "CANCELLED" } },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Cancel order" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.type(dlg.getByLabelText(/Reason/), "Customer asked");
    await u.click(dlg.getByRole("button", { name: "Cancel order" }));
    await waitFor(() => expect(callsTo("POST", "/orders/o1/cancel")).toHaveLength(1));
    expect(callsTo("POST", "/orders/o1/cancel")[0]!.body).toEqual({ reason: "Customer asked" });
  });

  it("adds an internal note", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, {
      "GET /orders/o1": { body: order("CONFIRMED") },
      "POST /orders/o1/notes": { status: 201, body: { id: "n2", body: "Called customer" } },
    });
    const u = userEvent.setup();
    expect(await screen.findByText("Gift wrap please")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("Write something first")).toBeInTheDocument();
    await u.type(screen.getByLabelText("Add a note"), "Called customer");
    await u.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(callsTo("POST", "/orders/o1/notes")).toHaveLength(1));
    expect(callsTo("POST", "/orders/o1/notes")[0]!.body).toEqual({ body: "Called customer" });
  });

  it("validates and sends a partial refund", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, {
      "GET /orders/o1": { body: order("DELIVERED") },
      "POST /payments/pay1/refund": { body: { ok: true } },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Refund payment pay1" }));
    const dlg = within(await screen.findByRole("dialog"));
    const amount = dlg.getByLabelText("Amount");
    await u.clear(amount);
    await u.type(amount, "500");
    await u.click(dlg.getByRole("button", { name: "Issue refund" }));
    expect(await dlg.findByText(/Cannot exceed/)).toBeInTheDocument();
    await u.clear(amount);
    await u.type(amount, "20");
    await u.type(dlg.getByLabelText("Reason"), "Damaged");
    await u.click(dlg.getByRole("button", { name: "Issue refund" }));
    await waitFor(() => expect(callsTo("POST", "/payments/pay1/refund")).toHaveLength(1));
    expect(callsTo("POST", "/payments/pay1/refund")[0]!.body).toEqual({
      amount: "20.00",
      reason: "Damaged",
    });
  });

  it("creates a manual shipment and tolerates a missing endpoint", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, {
      "GET /orders/o1": { body: order("PACKED") },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Create shipment" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.selectOptions(dlg.getByLabelText("Method"), "manual");
    await u.click(dlg.getByRole("button", { name: "Create shipment" }));
    expect(await dlg.findByText("AWB / tracking number is required")).toBeInTheDocument();
    await u.type(dlg.getByLabelText("AWB / tracking number"), "AWB123");
    await u.type(dlg.getByLabelText("Carrier"), "BlueDart");
    await u.click(dlg.getByRole("button", { name: "Create shipment" }));
    await waitFor(() => expect(callsTo("POST", "/orders/o1/shipments")).toHaveLength(1));
    expect(callsTo("POST", "/orders/o1/shipments")[0]!.body).toMatchObject({
      provider: "manual",
      awb: "AWB123",
      carrier: "BlueDart",
    });
    expect(
      await screen.findByText("Shipments is not available on this server"),
    ).toBeInTheDocument();
  });

  it("marks COD orders as paid", async () => {
    renderAt("/orders/o1", ADMIN_PERMS, {
      "GET /orders/o1": {
        body: order("CONFIRMED", {
          paymentProvider: "cod",
          paymentStatus: "PENDING",
          payments: [],
        }),
      },
      "POST /orders/o1/payments/mark-paid": { body: { ok: true } },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Mark as paid (COD)" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.click(dlg.getByRole("button", { name: "Mark as paid" }));
    await waitFor(() => expect(callsTo("POST", "/orders/o1/payments/mark-paid")).toHaveLength(1));
  });

  it("downloads the invoice through an authenticated blob request", async () => {
    const create = vi.fn(() => "blob:invoice");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderAt("/orders/o1", ADMIN_PERMS, {
      "GET /orders/o1": { body: order("CONFIRMED") },
      "GET /orders/o1/invoice.pdf": { body: {} },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Download invoice" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(callsTo("GET", "/orders/o1/invoice.pdf")).toHaveLength(1);
  });

  it("is read-only for admins without orders.update", async () => {
    renderAt("/orders/o1", READ_ONLY_PERMS, { "GET /orders/o1": { body: order("CONFIRMED") } });
    await screen.findByRole("heading", { name: "Order ORD-100001" });
    expect(screen.queryByRole("button", { name: /^Mark as/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add a note")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refund payment/ })).not.toBeInTheDocument();
    expect(screen.getByText("Gift wrap please")).toBeInTheDocument();
  });
});
