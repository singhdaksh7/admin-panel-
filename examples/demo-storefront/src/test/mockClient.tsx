import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import {
  CommerceError,
  type Cart,
  type CommerceClient,
  type Customer,
  type Order,
  type ProductDetail,
  type ProductListItem,
  type StoreSettings,
} from "@kash-commerce/storefront-sdk";
import { AppProviders } from "../context/providers";
import { AppRoutes } from "../App";

export const notFound = () =>
  new CommerceError({ status: 404, code: "NOT_FOUND", message: "Not found" });
export const unauthenticated = () =>
  new CommerceError({ status: 401, code: "UNAUTHENTICATED", message: "Authentication required" });

export const settings: StoreSettings = {
  name: "Test Store",
  legalName: null,
  logoMediaId: null,
  faviconMediaId: null,
  logoUrl: null,
  faviconUrl: null,
  supportEmail: null,
  phone: null,
  address: null,
  currency: "USD",
  locale: "en-US",
  timezone: "UTC",
  tax: { mode: "NONE", pricesIncludeTax: false },
  features: {
    customerAccounts: true,
    guestCheckout: true,
    reviews: true,
    blog: true,
    coupons: true,
    inventory: true,
  },
  social: null,
};

export const emptyCart: Cart = {
  token: null,
  currency: "USD",
  items: [],
  itemCount: 0,
  subtotal: "0.00",
  discount: "0.00",
  tax: "0.00",
  taxInclusive: false,
  taxBreakdown: [],
  total: "0.00",
  shippingExcluded: true,
  couponCode: null,
  couponError: null,
  warnings: [],
};

export const cartWithItem: Cart = {
  ...emptyCart,
  token: "tok-123456789",
  itemCount: 2,
  subtotal: "48.00",
  total: "48.00",
  items: [
    {
      variantId: "v-black-m",
      productId: "p1",
      title: "Classic Tee",
      variantTitle: "Black / M",
      sku: "TEE-B-M",
      imageUrl: null,
      attributes: [],
      unitPrice: "24.00",
      quantity: 2,
      discount: "0.00",
      taxRate: 0,
      tax: "0.00",
      lineTotal: "48.00",
    },
  ],
};

export const listItem = (over: Partial<ProductListItem> = {}): ProductListItem => ({
  id: "p1",
  title: "Classic Tee",
  slug: "classic-tee",
  shortDescription: "A tee",
  price: "24.00",
  compareAtPrice: null,
  currency: "USD",
  image: null,
  images: [],
  category: { name: "T-Shirts", slug: "t-shirts" },
  inStock: true,
  isFeatured: true,
  isNew: false,
  rating: { average: 0, count: 0 },
  ...over,
});

export const productDetail: ProductDetail = {
  ...listItem(),
  description: "Soft cotton.",
  brand: "Kash",
  seo: null,
  properties: null,
  tags: [],
  attributes: [],
  options: [
    {
      attribute: "Color",
      attributeSlug: "color",
      values: [
        { value: "Black", slug: "black" },
        { value: "White", slug: "white" },
      ],
    },
    {
      attribute: "Size",
      attributeSlug: "size",
      values: [{ value: "M", slug: "m" }],
    },
  ],
  variants: [
    {
      id: "v-black-m",
      sku: "TEE-B-M",
      title: "Black / M",
      price: "24.00",
      compareAtPrice: null,
      weightGrams: null,
      isDefault: true,
      attributes: [
        { attribute: "Color", attributeSlug: "color", value: "Black", valueSlug: "black" },
        { attribute: "Size", attributeSlug: "size", value: "M", valueSlug: "m" },
      ],
      inStock: true,
      available: 20,
      image: null,
    },
    {
      id: "v-white-m",
      sku: "TEE-W-M",
      title: "White / M",
      price: "29.00",
      compareAtPrice: "35.00",
      weightGrams: null,
      isDefault: false,
      attributes: [
        { attribute: "Color", attributeSlug: "color", value: "White", valueSlug: "white" },
        { attribute: "Size", attributeSlug: "size", value: "M", valueSlug: "m" },
      ],
      inStock: false,
      available: 0,
      image: null,
    },
  ],
  related: [],
};

export const customerFixture: Customer = {
  id: "c1",
  email: "ann@example.com",
  firstName: "Ann",
  lastName: null,
  phone: null,
  emailVerified: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

export const orderFixture: Order = {
  orderNumber: "KC-100001",
  status: "CONFIRMED",
  paymentStatus: "PENDING",
  currency: "USD",
  email: "guest@example.com",
  subtotal: "48.00",
  discount: "0.00",
  shipping: "5.00",
  tax: "0.00",
  taxBreakdown: null,
  total: "53.00",
  couponCode: null,
  shippingMethod: "Standard",
  shippingAddress: null,
  billingAddress: null,
  paymentProvider: "MANUAL",
  placedAt: "2026-01-01T00:00:00.000Z",
  cancelledAt: null,
  items: [
    {
      productId: "p1",
      variantId: "v-black-m",
      title: "Classic Tee",
      variantTitle: "Black / M",
      sku: "TEE-B-M",
      imageUrl: null,
      attributes: [],
      unitPrice: "24.00",
      quantity: 2,
      discount: "0.00",
      taxRate: "0",
      taxAmount: "0.00",
      lineTotal: "48.00",
    },
  ],
  timeline: [],
  payments: [],
};

/** A complete fake SDK client. Pass overrides (deep per-namespace) to change behaviour per test. */
export function makeClient(over: Record<string, Record<string, unknown>> = {}) {
  const page = <T,>(items: T[]) => ({
    items,
    page: 1,
    pageSize: 12,
    total: items.length,
    totalPages: 1,
  });
  const base = {
    store: { getSettings: vi.fn(async () => settings) },
    navigation: {
      get: vi.fn(async (menu = "header") => ({
        key: menu,
        name: menu,
        items:
          menu === "header"
            ? [
                {
                  id: "n1",
                  label: "Shop",
                  type: "LINK",
                  url: "/products",
                  badge: null,
                  promo: null,
                  showDesktop: true,
                  showMobile: true,
                  openInNewTab: false,
                  children: [
                    {
                      id: "n2",
                      label: "Apparel",
                      type: "CATEGORY",
                      url: "/category/apparel",
                      badge: null,
                      promo: null,
                      showDesktop: true,
                      showMobile: true,
                      openInNewTab: false,
                      children: [],
                    },
                  ],
                },
              ]
            : [],
      })),
    },
    categories: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => {
        throw notFound();
      }),
    },
    pages: {
      get: vi.fn(async () => {
        throw notFound();
      }),
      list: vi.fn(async () => []),
    },
    products: {
      list: vi.fn(async () => page([listItem()])),
      getBySlug: vi.fn(async () => productDetail),
    },
    filters: { get: vi.fn(async () => ({ category: null, groups: [] })) },
    auth: {
      me: vi.fn(async () => {
        throw unauthenticated();
      }),
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(async () => ({ ok: true })),
      forgotPassword: vi.fn(),
    },
    cart: {
      get: vi.fn(async () => emptyCart),
      add: vi.fn(async () => cartWithItem),
      update: vi.fn(async () => cartWithItem),
      remove: vi.fn(async () => emptyCart),
      applyCoupon: vi.fn(async () => ({ ...cartWithItem, couponCode: "SAVE10" })),
      removeCoupon: vi.fn(async () => cartWithItem),
    },
    checkout: {
      shippingMethods: vi.fn(async () => [
        {
          code: "standard",
          name: "Standard",
          type: "FLAT",
          price: "5.00",
          freeOverAmount: null,
          minDays: 3,
          maxDays: 5,
          countries: [],
          cost: "5.00",
        },
      ]),
      summary: vi.fn(async () => ({
        currency: "USD",
        subtotal: "48.00",
        discount: "0.00",
        shipping: "5.00",
        tax: "0.00",
        taxInclusive: false,
        taxBreakdown: [],
        total: "53.00",
        coupon: null,
        shippingMethod: { code: "standard", name: "Standard", price: "5.00" },
        lines: [],
      })),
      create: vi.fn(),
    },
    payments: { verify: vi.fn(), retry: vi.fn() },
    orders: {
      get: vi.fn(),
      invoiceUrl: vi.fn(() => "http://api/invoice.pdf"),
    },
    reviews: {
      list: vi.fn(async () => ({
        ...page([]),
        aggregate: {
          average: 0,
          count: 0,
          distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
        },
      })),
      create: vi.fn(async () => ({
        id: "r1",
        status: "PENDING",
        rating: 5,
        verifiedPurchase: false,
        message: "Thanks!",
      })),
    },
    blog: { list: vi.fn(async () => page([])), getBySlug: vi.fn() },
    seo: {
      jsonLd: vi.fn(async () => ({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Classic Tee",
      })),
    },
    account: {
      orders: { list: vi.fn(async () => page([])), get: vi.fn() },
      addresses: { list: vi.fn(async () => []), create: vi.fn(), remove: vi.fn() },
    },
  } as Record<string, Record<string, unknown>>;
  for (const [ns, fns] of Object.entries(over)) base[ns] = { ...(base[ns] ?? {}), ...fns };
  return base as unknown as CommerceClient & typeof base;
}

export function renderApp(client: ReturnType<typeof makeClient>, route = "/", extra?: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppProviders client={client}>
        <AppRoutes />
        {extra}
      </AppProviders>
    </MemoryRouter>,
  );
}
