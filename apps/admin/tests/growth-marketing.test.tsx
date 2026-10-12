import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lastCall, mockFetch, paginated, renderApp, type Handler } from "./growth-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const review = (id: string, name: string, over = {}) => ({
  id,
  authorName: name,
  authorEmail: `${name.toLowerCase()}@x.test`,
  rating: 4,
  title: "Nice",
  body: "Works well",
  status: "PENDING",
  verifiedPurchase: true,
  moderationNote: null,
  createdAt: "2026-01-02T10:00:00Z",
  product: { id: "p1", title: "Blue Shirt", slug: "blue-shirt" },
  ...over,
});

const reviewsApi: Handler = (_u, init, path) => {
  const method = init.method ?? "GET";
  if (path.startsWith("/reviews?"))
    return {
      body: paginated([
        review("r1", "Jo"),
        review("r2", "Sam", { rating: 2, verifiedPurchase: false }),
      ]),
    };
  if (path.startsWith("/reviews/r1/moderate") && method === "PATCH") return { body: { id: "r1" } };
  if (path === "/reviews/bulk" && method === "POST") return { body: { affected: 2 } };
  if (path === "/reviews/r2" && method === "DELETE") return { status: 204 };
  return undefined;
};

describe("reviews moderation", () => {
  it("shows stars, verified badge and product", async () => {
    mockFetch(reviewsApi, ["reviews.read", "reviews.moderate"]);
    renderApp("/reviews");
    expect(await screen.findAllByText("Works well")).toHaveLength(2);
    expect(screen.getAllByText("Blue Shirt")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "4 out of 5 stars" })).toBeInTheDocument();
    expect(screen.getByText("verified purchase")).toBeInTheDocument();
  });

  it("approves with a note and rejects without one (exact payloads)", async () => {
    mockFetch(reviewsApi, ["reviews.read", "reviews.moderate"]);
    renderApp("/reviews");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Approve review by Jo" }));
    let dialog = await screen.findByRole("dialog");
    await u.type(within(dialog).getByLabelText(/Moderation note/), "Looks genuine");
    await u.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(lastCall("PATCH", "/reviews/r1/moderate")).toBeTruthy());
    expect(lastCall("PATCH", "/reviews/r1/moderate")!.body).toEqual({
      status: "APPROVED",
      moderationNote: "Looks genuine",
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await u.click(await screen.findByRole("button", { name: "Reject review by Jo" }));
    dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(lastCall("PATCH", "/reviews/r1/moderate")!.body).toEqual({ status: "REJECTED" }),
    );
  });

  it("bulk-rejects selected reviews via /reviews/bulk", async () => {
    mockFetch(reviewsApi, ["reviews.read", "reviews.moderate"]);
    renderApp("/reviews");
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText("Select all reviews"));
    await u.click(screen.getByRole("button", { name: "Reject selected" }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(lastCall("POST", "/reviews/bulk")).toBeTruthy());
    expect(lastCall("POST", "/reviews/bulk")!.body).toEqual({
      ids: ["r1", "r2"],
      action: "reject",
    });
  });

  it("deletes after confirmation and hides moderation for read-only admins", async () => {
    mockFetch(reviewsApi, ["reviews.read", "reviews.moderate"]);
    renderApp("/reviews");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Delete review by Sam" }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(lastCall("DELETE", "/reviews/r2")).toBeTruthy());
    cleanup();
    mockFetch(reviewsApi, ["reviews.read"]);
    renderApp("/reviews");
    await screen.findAllByText("Works well");
    expect(screen.queryByRole("button", { name: /Approve review/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select all reviews")).not.toBeInTheDocument();
  });
});

describe("coupons", () => {
  const couponsApi: Handler = (_u, init, path) => {
    const method = init.method ?? "GET";
    if (path.startsWith("/coupons?")) return { body: paginated([]) };
    if (path === "/coupons" && method === "POST") return { status: 201, body: { id: "c1" } };
    if (path.startsWith("/categories")) return { body: { items: [] } };
    return undefined;
  };

  it("validates client-side then creates with the expected payload", async () => {
    mockFetch(couponsApi, ["coupons.read", "coupons.write", "products.read", "categories.read"]);
    renderApp("/coupons/new");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Create coupon" }));
    expect(
      await screen.findByText("3-40 characters: letters, digits, - and _"),
    ).toBeInTheDocument();
    expect(lastCall("POST", "/coupons")).toBeUndefined();

    await u.type(screen.getByLabelText("Code"), "save10");
    await u.type(screen.getByLabelText("Value (%)"), "150");
    await u.click(screen.getByRole("button", { name: "Create coupon" }));
    expect(await screen.findByText("Percentage must be between 0 and 100")).toBeInTheDocument();

    await u.clear(screen.getByLabelText("Value (%)"));
    await u.type(screen.getByLabelText("Value (%)"), "10");
    await u.type(screen.getByLabelText("Minimum order amount"), "50.00");
    await u.click(screen.getByRole("button", { name: "Create coupon" }));
    await waitFor(() => expect(lastCall("POST", "/coupons")).toBeTruthy());
    expect(lastCall("POST", "/coupons")!.body).toEqual({
      code: "SAVE10",
      description: null,
      discountType: "PERCENTAGE",
      value: "10",
      minOrderAmount: "50.00",
      maxDiscount: null,
      startsAt: null,
      endsAt: null,
      usageLimit: null,
      perCustomerLimit: null,
      isActive: true,
      productIds: [],
      categoryIds: [],
    });
  });

  it("maps a duplicate-code 409 onto the code field", async () => {
    mockFetch(
      (u, i, p) => {
        if (p === "/coupons" && i.method === "POST")
          return {
            status: 409,
            body: { error: { code: "CONFLICT", message: "Coupon code already exists" } },
          };
        return couponsApi(u, i, p);
      },
      ["coupons.read", "coupons.write"],
    );
    renderApp("/coupons/new");
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Code"), "DUP");
    await u.type(screen.getByLabelText("Value (%)"), "5");
    await u.click(screen.getByRole("button", { name: "Create coupon" }));
    expect((await screen.findAllByText("Coupon code already exists")).length).toBeGreaterThan(0);
  });

  it("hides the new-coupon button without coupons.write", async () => {
    mockFetch(couponsApi, ["coupons.read"]);
    renderApp("/coupons");
    await screen.findByText("No coupons found");
    expect(screen.queryByText("New coupon")).not.toBeInTheDocument();
  });
});
