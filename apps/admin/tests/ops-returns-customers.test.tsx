import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN_PERMS, READ_ONLY_PERMS, callsTo, page, renderAt } from "./ops-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Mirrors the REAL admin returns DTO from apps/api/src/modules/returns (adminDto). */
const ret = (status: string) => ({
  id: "r1",
  orderId: "o1",
  orderNumber: "ORD-100001",
  email: "buyer@example.com",
  status,
  reason: "Wrong size",
  details: "Too small",
  decisionNote: null,
  refundAmount: null,
  currency: "USD",
  createdAt: "2026-02-02T10:00:00Z",
  items: [
    {
      id: "ri1",
      orderItemId: "oi1",
      title: "Linen Shirt",
      variantTitle: null,
      sku: "LS-1",
      quantity: 1,
      restock: false,
      lineTotal: "25.00",
      orderedQuantity: 2,
    },
  ],
  history: [{ status: "REQUESTED", note: null, actorId: null, at: "2026-02-02T10:00:00Z" }],
});

describe("returns", () => {
  it("shows a not-available message when the API has no returns endpoint", async () => {
    renderAt("/returns", ADMIN_PERMS, {});
    expect(await screen.findByText("Returns are not available")).toBeInTheDocument();
  });

  it("lists returns with a status filter", async () => {
    renderAt("/returns", ADMIN_PERMS, {
      "GET /returns": { body: page([{ ...ret("REQUESTED"), items: undefined }]) },
    });
    expect(await screen.findByText("ORD-100001")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText("Filter by status"), "APPROVED");
    await waitFor(() =>
      expect(callsTo("GET", "/returns").at(-1)!.query.get("status")).toBe("APPROVED"),
    );
  });

  it("renders detail fields from the real API shape (item title, history date)", async () => {
    renderAt("/returns/r1", ADMIN_PERMS, { "GET /returns/r1": { body: ret("REQUESTED") } });
    expect(await screen.findByText("Linen Shirt")).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/i)).not.toBeInTheDocument();
  });

  it("approves a requested return", async () => {
    renderAt("/returns/r1", ADMIN_PERMS, {
      "GET /returns/r1": { body: ret("REQUESTED") },
      "POST /returns/r1/approve": { body: ret("APPROVED") },
      "POST /returns/r1/reject": { body: ret("REJECTED") },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Approve" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.type(dlg.getByLabelText(/Note/), "ok");
    await u.click(dlg.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(callsTo("POST", "/returns/r1/approve")).toHaveLength(1));
    expect(callsTo("POST", "/returns/r1/approve")[0]!.body).toEqual({ note: "ok" });
  });

  it("requires a note to reject", async () => {
    renderAt("/returns/r1", ADMIN_PERMS, {
      "GET /returns/r1": { body: ret("REQUESTED") },
      "POST /returns/r1/reject": { body: ret("REJECTED") },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Reject" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.click(dlg.getByRole("button", { name: "Reject" }));
    expect(await dlg.findByText("Reason for rejection is required")).toBeInTheDocument();
    expect(callsTo("POST", "/returns/r1/reject")).toHaveLength(0);
    await u.type(dlg.getByLabelText("Reason for rejection"), "Worn item");
    await u.click(dlg.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(callsTo("POST", "/returns/r1/reject")).toHaveLength(1));
  });

  it("receives items with restock toggles, then refunds", async () => {
    renderAt("/returns/r1", ADMIN_PERMS, {
      "GET /returns/r1": { body: ret("APPROVED") },
      "POST /returns/r1/receive": { body: ret("RECEIVED") },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Receive items" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.click(dlg.getByLabelText(/Restock 1 × Linen Shirt/));
    await u.click(dlg.getByRole("button", { name: "Mark received" }));
    await waitFor(() => expect(callsTo("POST", "/returns/r1/receive")).toHaveLength(1));
    expect(callsTo("POST", "/returns/r1/receive")[0]!.body).toEqual({
      items: [{ returnItemId: "ri1", restock: true }],
    });
    cleanup();
    renderAt("/returns/r1", ADMIN_PERMS, {
      "GET /returns/r1": { body: ret("RECEIVED") },
      "POST /returns/r1/refund": { body: ret("REFUNDED") },
    });
    await u.click(await screen.findByRole("button", { name: "Issue refund" }));
    const d2 = within(await screen.findByRole("dialog"));
    await u.type(d2.getByLabelText(/Refund amount/), "15.5");
    await u.click(d2.getByRole("button", { name: "Issue refund" }));
    await waitFor(() => expect(callsTo("POST", "/returns/r1/refund")).toHaveLength(1));
    expect(callsTo("POST", "/returns/r1/refund")[0]!.body).toEqual({ amount: "15.50" });
  });

  it("hides actions without returns.manage", async () => {
    renderAt("/returns/r1", READ_ONLY_PERMS, { "GET /returns/r1": { body: ret("REQUESTED") } });
    await screen.findByText("Wrong size");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});

const customer = {
  id: "cu1",
  email: "asha@x.test",
  firstName: "Asha",
  lastName: "Rao",
  phone: null,
  isActive: true,
  isGuest: false,
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00Z",
  addresses: [],
  ordersSummary: {
    count: 1,
    totalSpent: "123.00",
    recent: [
      {
        id: "o1",
        orderNumber: "ORD-100001",
        status: "DELIVERED",
        paymentStatus: "PAID",
        total: "123.00",
        currency: "USD",
        placedAt: "2026-02-01T10:00:00Z",
      },
    ],
  },
};

describe("customers", () => {
  it("lists and searches customers", async () => {
    renderAt("/customers", ADMIN_PERMS, {
      "GET /customers": { body: page([{ ...customer, orderCount: 2 }]) },
    });
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Search name, email or phone"), "asha");
    await waitFor(() => expect(callsTo("GET", "/customers").at(-1)!.query.get("q")).toBe("asha"));
  });

  it("deactivates a customer after confirmation", async () => {
    renderAt("/customers/cu1", ADMIN_PERMS, {
      "GET /customers/cu1": { body: customer },
      "PATCH /customers/cu1": { body: { ...customer, isActive: false } },
    });
    const u = userEvent.setup();
    expect(await screen.findByText("ORD-100001")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Deactivate" }));
    const dlg = within(await screen.findByRole("dialog"));
    expect(callsTo("PATCH", "/customers/cu1")).toHaveLength(0);
    await u.click(dlg.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(callsTo("PATCH", "/customers/cu1")).toHaveLength(1));
    expect(callsTo("PATCH", "/customers/cu1")[0]!.body).toEqual({ isActive: false });
  });

  it("offers reactivation and hides it for read-only admins", async () => {
    renderAt("/customers/cu1", ADMIN_PERMS, {
      "GET /customers/cu1": { body: { ...customer, isActive: false } },
    });
    expect(await screen.findByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    cleanup();
    renderAt("/customers/cu1", READ_ONLY_PERMS, { "GET /customers/cu1": { body: customer } });
    await screen.findByText("ORD-100001");
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });
});
