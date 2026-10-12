import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PageSection } from "@kash-commerce/storefront-sdk";
import {
  cartWithItem,
  customerFixture,
  listItem,
  makeClient,
  notFound,
  orderFixture,
  productDetail,
  renderApp,
} from "./mockClient";

const homePage = (sections: PageSection[]) => ({
  slug: "home",
  title: "Home",
  seo: null,
  sections,
});

describe("Home (CMS sections)", () => {
  it("renders CMS sections generically by type, with a JSON fallback for CUSTOM_JSON", async () => {
    const sections = [
      {
        id: "s1",
        type: "HERO",
        key: null,
        sortOrder: 0,
        content: {
          heading: "Basics, done properly",
          subheading: "Honest prices",
          align: "left",
          cta: { label: "Shop all", url: "/products" },
        },
      },
      {
        id: "s2",
        type: "PRODUCT_GRID",
        key: null,
        sortOrder: 1,
        content: {
          heading: "Featured",
          limit: 4,
          items: [
            {
              id: "p9",
              slug: "boxy-tee",
              title: "Boxy Tee",
              brand: null,
              shortDescription: null,
              price: "29.00",
              compareAtPrice: null,
              imageUrl: null,
              isNew: true,
              isFeatured: false,
              rating: { average: 0, count: 0 },
            },
          ],
        },
      },
      {
        id: "s3",
        type: "RICH_TEXT",
        key: null,
        sortOrder: 2,
        content: { html: "<p>Rich <strong>words</strong></p>" },
      },
      {
        id: "s4",
        type: "PROMO_BANNER",
        key: null,
        sortOrder: 3,
        content: { text: "Free shipping over $75", cta: { label: "Go", url: "/products" } },
      },
      { id: "s5", type: "CUSTOM_JSON", key: null, sortOrder: 4, content: { foo: "bar" } },
      { id: "s6", type: "FUTURE_TYPE", key: null, sortOrder: 5, content: { a: 1 } },
    ] as unknown as PageSection[];
    const client = makeClient({ pages: { get: vi.fn(async () => homePage(sections)) } });
    renderApp(client);
    expect(
      await screen.findByRole("heading", { name: "Basics, done properly" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Boxy Tee" })).toHaveAttribute(
      "href",
      "/product/boxy-tee",
    );
    expect(screen.getByText("words")).toBeInTheDocument();
    expect(screen.getByText("Free shipping over $75")).toBeInTheDocument();
    expect(screen.getByText(/Custom section: CUSTOM_JSON/)).toBeInTheDocument();
    expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
    expect(screen.getByText(/Custom section: FUTURE_TYPE/)).toBeInTheDocument();
    expect(client.pages.get).toHaveBeenCalledWith("home");
  });

  it("falls back to featured products when there is no home page", async () => {
    const client = makeClient();
    renderApp(client);
    expect(await screen.findByRole("heading", { name: "Featured products" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Classic Tee" })).toBeInTheDocument();
    expect(client.products.list).toHaveBeenCalledWith({ sort: "featured", pageSize: 8 });
  });
});

describe("Header navigation", () => {
  it("shows the store name from settings and nested navigation from the API", async () => {
    renderApp(makeClient());
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(await screen.findAllByText("Test Store")).not.toHaveLength(0);
    expect(within(nav).getByRole("link", { name: "Shop" })).toHaveAttribute("href", "/products");
    const toggle = within(nav).getByRole("button", { name: "Shop submenu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("link", { name: "Apparel" })).toHaveAttribute(
      "href",
      "/category/apparel",
    );
  });
});

describe("Listing and filters", () => {
  const filterGroups = [
    {
      id: "g1",
      source: "ATTRIBUTE",
      key: "attr.color",
      label: "Color",
      type: "multi",
      open: true,
      showDesktop: true,
      showMobile: true,
      options: [
        { value: "black", label: "Black", count: 3, selected: false },
        { value: "white", label: "White", count: 1, selected: false },
      ],
    },
    {
      id: "g2",
      source: "PRICE",
      key: "price",
      label: "Price",
      type: "range",
      open: true,
      showDesktop: true,
      showMobile: true,
      options: [],
      range: { min: "10.00", max: "90.00" },
    },
  ];

  it("renders products, facet counts, and re-queries when a filter or sort changes", async () => {
    const client = makeClient({
      filters: { get: vi.fn(async () => ({ category: null, groups: filterGroups })) },
    });
    renderApp(client, "/products");
    expect(await screen.findByRole("link", { name: "Classic Tee" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Black/)).not.toBeChecked();
    expect(screen.getByText("(3)")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/Black/));
    await waitFor(() =>
      expect(client.products.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ attributes: { color: ["black"] }, pageSize: 12 }),
      ),
    );
    expect(client.filters.get).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selections: expect.objectContaining({ attributes: { color: ["black"] } }),
      }),
    );

    await userEvent.selectOptions(screen.getByLabelText(/Sort by/), "price_asc");
    await waitFor(() =>
      expect(client.products.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "price_asc" }),
      ),
    );
  });

  it("applies a price range and paginates", async () => {
    const client = makeClient({
      filters: { get: vi.fn(async () => ({ category: null, groups: filterGroups })) },
      products: {
        list: vi.fn(async () => ({
          items: [listItem()],
          page: 1,
          pageSize: 12,
          total: 30,
          totalPages: 3,
        })),
      },
    });
    renderApp(client, "/products");
    await screen.findByRole("link", { name: "Classic Tee" });
    await userEvent.type(screen.getByLabelText("Min"), "20");
    await userEvent.type(screen.getByLabelText("Max"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(client.products.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ minPrice: "20", maxPrice: "50" }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(client.products.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );
  });

  it("shows 404 for an unknown category", async () => {
    const client = makeClient();
    renderApp(client, "/category/nope");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});

describe("Product detail", () => {
  it("selects variants, shows price / stock, and adds the chosen variant to the cart", async () => {
    const client = makeClient();
    renderApp(client, "/product/classic-tee");
    expect(await screen.findByRole("heading", { name: "Classic Tee" })).toBeInTheDocument();
    expect(screen.getByText("In stock")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() =>
      expect(client.cart.add).toHaveBeenCalledWith({ variantId: "v-black-m", quantity: 1 }),
    );
    expect(await screen.findByText(/Added to cart/)).toBeInTheDocument();

    // pick the sold-out White variant: price/compare-at update, button disabled
    await userEvent.click(screen.getByLabelText("White"));
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
    expect(screen.getByLabelText("Original price")).toHaveTextContent("$35.00");
    expect(screen.getByRole("button", { name: "Add to cart" })).toBeDisabled();
  });

  it("injects JSON-LD from the SEO endpoint", async () => {
    const client = makeClient();
    const { container } = renderApp(client, "/product/classic-tee");
    await waitFor(() =>
      expect(container.querySelector('script[type="application/ld+json"]')).not.toBeNull(),
    );
    expect(client.seo.jsonLd).toHaveBeenCalledWith("product", "classic-tee");
    const json = JSON.parse(
      container.querySelector('script[type="application/ld+json"]')!.textContent!,
    );
    expect(json["@type"]).toBe("Product");
  });

  it("submits a review and tells the shopper it is pending moderation", async () => {
    const client = makeClient();
    renderApp(client, "/product/classic-tee");
    await screen.findByRole("heading", { name: "Write a review" });
    await userEvent.type(screen.getByLabelText("Your name"), "Sam");
    await userEvent.type(screen.getByLabelText(/Email/), "sam@example.com");
    await userEvent.type(screen.getByLabelText("Review"), "Really nice");
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
    expect(await screen.findByText(/pending moderation/i)).toBeInTheDocument();
    expect(client.reviews.create).toHaveBeenCalledWith(
      "classic-tee",
      expect.objectContaining({
        rating: 5,
        authorName: "Sam",
        email: "sam@example.com",
        body: "Really nice",
      }),
    );
  });

  it("renders an unknown product as 404", async () => {
    const client = makeClient({
      products: {
        getBySlug: vi.fn(async () => {
          throw notFound();
        }),
      },
    });
    renderApp(client, "/product/missing");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});

describe("Cart", () => {
  it("updates quantity, removes lines and applies a coupon", async () => {
    const client = makeClient({ cart: { get: vi.fn(async () => cartWithItem) } });
    renderApp(client, "/cart");
    const qty = await screen.findByLabelText("Quantity for Classic Tee");
    await userEvent.clear(qty);
    await userEvent.type(qty, "3");
    await userEvent.tab();
    await waitFor(() => expect(client.cart.update).toHaveBeenCalledWith("v-black-m", 3));

    await userEvent.type(screen.getByLabelText("Coupon code"), "SAVE10");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(client.cart.applyCoupon).toHaveBeenCalledWith("SAVE10"));
    expect(await screen.findByText("SAVE10")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove Classic Tee" }));
    await waitFor(() => expect(client.cart.remove).toHaveBeenCalledWith("v-black-m"));
    expect(await screen.findByText("Your cart is empty.")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    renderApp(makeClient(), "/cart");
    expect(await screen.findByText("Your cart is empty.")).toBeInTheDocument();
  });
});

describe("Checkout", () => {
  async function fillAddress() {
    await userEvent.type(await screen.findByLabelText("Email"), "guest@example.com");
    const ship = screen.getByRole("group", { name: "Shipping address" });
    await userEvent.type(within(ship).getByLabelText("Full name"), "Gus Guest");
    await userEvent.type(within(ship).getByLabelText("Address line 1"), "1 Main St");
    await userEvent.type(within(ship).getByLabelText("City"), "Town");
    await userEvent.type(within(ship).getByLabelText("Postal code"), "12345");
  }

  it("places a cash-on-delivery order and lands on the confirmation page", async () => {
    const client = makeClient({
      cart: { get: vi.fn(async () => cartWithItem) },
      checkout: {
        create: vi.fn(async () => ({
          order: { ...orderFixture },
          paymentRequired: false,
          paymentProvider: "MANUAL",
          providerAvailable: false,
          clientPayload: null,
        })),
      },
      orders: {
        get: vi.fn(async () => orderFixture),
        invoiceUrl: vi.fn(() => "http://api/inv.pdf"),
      },
    });
    renderApp(client, "/checkout");
    await fillAddress();
    await waitFor(() => expect(client.checkout.summary).toHaveBeenCalled());
    expect(await screen.findByText("$53.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => expect(client.checkout.create).toHaveBeenCalled());
    const input = (client.checkout.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input).toMatchObject({
      email: "guest@example.com",
      paymentProvider: "MANUAL",
      shippingMethodCode: "standard",
      shippingAddress: { fullName: "Gus Guest", country: "US", postalCode: "12345" },
    });
    expect(await screen.findByRole("heading", { name: "Thank you!" })).toBeInTheDocument();
    expect(client.orders.get).toHaveBeenCalledWith("KC-100001", "guest@example.com");
  });

  it("offers a DEMO-ONLY simulated payment for the MOCK provider and verifies it", async () => {
    const client = makeClient({
      cart: { get: vi.fn(async () => cartWithItem) },
      checkout: {
        create: vi.fn(async () => ({
          order: orderFixture,
          paymentRequired: true,
          paymentProvider: "MOCK",
          providerAvailable: true,
          clientPayload: {
            mock: true,
            providerOrderId: "mock_order_1",
            amount: "53.00",
            currency: "USD",
          },
        })),
      },
      payments: { verify: vi.fn(async () => ({ verified: true })) },
      orders: { get: vi.fn(async () => orderFixture), invoiceUrl: vi.fn(() => "x") },
    });
    renderApp(client, "/checkout");
    await fillAddress();
    await userEvent.click(screen.getByLabelText(/Pay online/));
    await userEvent.click(screen.getByRole("button", { name: "Place order" }));
    expect(await screen.findByText(/DEMO ONLY/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Simulate payment" }));
    await waitFor(() => expect(client.payments.verify).toHaveBeenCalled());
    const arg = (client.payments.verify as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg).toMatchObject({
      orderNumber: "KC-100001",
      email: "guest@example.com",
      providerOrderId: "mock_order_1",
    });
    expect(arg.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(await screen.findByRole("heading", { name: "Thank you!" })).toBeInTheDocument();
  });
});

describe("Account", () => {
  it("signs a customer in and shows their orders and addresses", async () => {
    const client = makeClient({
      auth: {
        login: vi.fn(async () => ({ customer: customerFixture, csrfToken: "c" })),
        me: vi.fn().mockRejectedValueOnce(new Error("no session")),
      },
      account: {
        orders: {
          list: vi.fn(async () => ({
            items: [orderFixture],
            page: 1,
            pageSize: 10,
            total: 1,
            totalPages: 1,
          })),
        },
        addresses: { list: vi.fn(async () => []) },
      },
    });
    renderApp(client, "/account");
    await userEvent.type(await screen.findByLabelText("Email"), "ann@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "Passw0rd!!");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(client.auth.login).toHaveBeenCalledWith(
        { email: "ann@example.com", password: "Passw0rd!!" },
        { mergeCart: true },
      ),
    );
    expect(await screen.findByRole("heading", { name: /Hello, Ann/ })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "KC-100001" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(client.auth.logout).toHaveBeenCalled());
  });
});

describe("Routing", () => {
  it("renders CMS pages at /pages/:slug and a 404 for unknown routes", async () => {
    const client = makeClient({
      pages: {
        get: vi.fn(async (slug: string) => ({
          slug,
          title: "About us",
          seo: null,
          sections: [
            {
              id: "a",
              type: "RICH_TEXT",
              key: null,
              sortOrder: 0,
              content: { html: "<h1>About us</h1>" },
            },
          ],
        })),
      },
    });
    const first = renderApp(client, "/pages/about");
    expect(await screen.findByRole("heading", { name: "About us" })).toBeInTheDocument();
    first.unmount();
    renderApp(makeClient(), "/definitely/not/a/page");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });

  it("lists blog posts", async () => {
    const client = makeClient({
      blog: {
        list: vi.fn(async () => ({
          items: [
            {
              id: "b1",
              slug: "welcome",
              title: "Welcome",
              excerpt: "Hi",
              authorName: null,
              tags: [],
              coverUrl: null,
              publishedAt: "2026-01-01T00:00:00Z",
            },
          ],
          page: 1,
          pageSize: 9,
          total: 1,
          totalPages: 1,
        })),
      },
    });
    renderApp(client, "/blog");
    expect(await screen.findByRole("link", { name: "Welcome" })).toHaveAttribute(
      "href",
      "/blog/welcome",
    );
  });
});

void productDetail;
