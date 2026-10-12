import { Transport, type CommerceClientOptions, type RequestOptions } from "./http";
import { CommerceError } from "./errors";
import { productQueryParams, type QueryParams } from "./query";
import type {
  Address,
  AddressInput,
  AuthSession,
  BlogPost,
  BlogPostSummary,
  BlogQuery,
  Cart,
  CategoryDetail,
  CategoryNode,
  ChangePasswordInput,
  CheckoutCreateInput,
  CheckoutResult,
  CheckoutSummary,
  CheckoutSummaryInput,
  CollectionDetail,
  CollectionSummary,
  Customer,
  FilterSelections,
  FiltersResponse,
  JsonLd,
  JsonLdType,
  ListResult,
  LoginInput,
  NavigationMenu,
  OkResult,
  Order,
  OrderTracking,
  Page,
  PageSummary,
  Paginated,
  PaymentRetryInput,
  PaymentRetryResult,
  PaymentVerifyInput,
  PaymentVerifyResult,
  ProductDetail,
  ProductListItem,
  ProductQuery,
  ProfileInput,
  RegisterInput,
  ResetPasswordInput,
  ResolvedSeo,
  ReturnCreateInput,
  ReturnRequest,
  Review,
  ReviewInput,
  ReviewList,
  ReviewQuery,
  ReviewSubmitResult,
  RobotsInfo,
  SeoDefaults,
  ShippingMethod,
  Sitemap,
  StoreSettings,
} from "./types";

/** Per-call options accepted by every method that performs a request. */
export interface CallOptions {
  signal?: AbortSignal;
}

const enc = encodeURIComponent;

export const hasNextPage = (p: Pick<Paginated<unknown>, "page" | "totalPages">): boolean =>
  p.page < p.totalPages;

/** Generic async iterator over every item of a paginated endpoint. */
export async function* paginate<T>(
  fetchPage: (page: number) => Promise<Paginated<T>>,
  opts: { startPage?: number; maxPages?: number } = {},
): AsyncGenerator<T, void, undefined> {
  let page = opts.startPage ?? 1;
  const max = opts.maxPages ?? Infinity;
  for (let n = 0; n < max; n++) {
    const res = await fetchPage(page);
    for (const item of res.items) yield item;
    if (!hasNextPage(res) || res.items.length === 0) return;
    page = res.page + 1;
  }
}

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const rnd = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `${rnd()}-${rnd()}-${Date.now().toString(16)}-${rnd()}`;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function createCommerceClient(options: CommerceClientOptions) {
  const t = new Transport(options);
  const get = <R>(path: string, query?: QueryParams, o: Partial<RequestOptions> = {}) =>
    t.request<R>({ path, query, ...o });
  const send = <R>(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    o: Partial<RequestOptions> = {},
  ) => t.request<R>({ method, path, body, ...o });

  // ───────── store ─────────
  const store = {
    getSettings: (c?: CallOptions) => get<StoreSettings>("/store/settings", undefined, c),
  };

  // ───────── catalog ─────────
  const products = {
    list: (query: ProductQuery = {}, c?: CallOptions) =>
      get<Paginated<ProductListItem>>("/products", productQueryParams(query), c),
    getBySlug: (slug: string, c?: CallOptions) =>
      get<ProductDetail>(`/products/${enc(slug)}`, undefined, c),
    search: (q: string, opts: Omit<ProductQuery, "q"> = {}, c?: CallOptions) =>
      get<Paginated<ProductListItem>>("/products/search", productQueryParams({ ...opts, q }), c),
    /** Async iterator over every matching product (follows pagination). */
    listAll: (query: ProductQuery = {}, opts: { maxPages?: number } = {}) =>
      paginate((page) => products.list({ ...query, page }), {
        startPage: query.page ?? 1,
        maxPages: opts.maxPages,
      }),
    hasNextPage,
  };

  const categories = {
    /** Root categories with nested `children`. Pass `{ counts: true }` for `productCount`. */
    list: async (opts: { counts?: boolean } = {}, c?: CallOptions) =>
      (
        await get<ListResult<CategoryNode>>(
          "/categories",
          { counts: opts.counts ? true : undefined },
          c,
        )
      ).items,
    get: (slug: string, c?: CallOptions) =>
      get<CategoryDetail>(`/categories/${enc(slug)}`, undefined, c),
  };

  const collections = {
    list: async (c?: CallOptions) =>
      (await get<ListResult<CollectionSummary>>("/collections", undefined, c)).items,
    get: (
      slug: string,
      query: Pick<ProductQuery, "page" | "pageSize" | "sort"> = {},
      c?: CallOptions,
    ) => get<CollectionDetail>(`/collections/${enc(slug)}`, { ...query }, c),
  };

  const navigation = {
    /** `menu` is a menu key (default "header"; "footer" is also provisioned). */
    get: (menu = "header", c?: CallOptions) => get<NavigationMenu>("/navigation", { menu }, c),
    getAll: async (c?: CallOptions) =>
      (await get<{ menus: NavigationMenu[] }>("/navigation", { menu: "all" }, c)).menus,
  };

  const pages = {
    list: async (c?: CallOptions) =>
      (await get<ListResult<PageSummary>>("/pages", undefined, c)).items,
    get: (slug: string, c?: CallOptions) => get<Page>(`/pages/${enc(slug)}`, undefined, c),
  };

  const filters = {
    /**
     * Facet groups with counts for a category (or the whole catalogue).
     * `selections` uses the same grammar as the product query and drives `selected`/counts.
     */
    get: (
      args: {
        category?: string;
        selections?: FilterSelections;
        device?: "desktop" | "mobile";
      } = {},
      c?: CallOptions,
    ) =>
      get<FiltersResponse>(
        "/filters",
        {
          ...productQueryParams({ ...args.selections, category: args.category }),
          device: args.device,
        },
        c,
      ),
  };

  // ───────── cart ─────────
  const cartReq = { cart: true } as const;
  const cart = {
    get: (c?: CallOptions) => get<Cart>("/cart", undefined, { ...cartReq, ...c }),
    add: (item: { variantId: string; quantity?: number }, c?: CallOptions) =>
      send<Cart>(
        "POST",
        "/cart/items",
        { variantId: item.variantId, quantity: item.quantity ?? 1 },
        { ...cartReq, ...c },
      ),
    /** Set an absolute quantity; 0 removes the line. */
    update: (variantId: string, quantity: number, c?: CallOptions) =>
      send<Cart>("PATCH", `/cart/items/${enc(variantId)}`, { quantity }, { ...cartReq, ...c }),
    remove: (variantId: string, c?: CallOptions) =>
      send<Cart>("DELETE", `/cart/items/${enc(variantId)}`, undefined, { ...cartReq, ...c }),
    applyCoupon: (code: string, c?: CallOptions) =>
      send<Cart>("POST", "/cart/coupon", { code }, { ...cartReq, ...c }),
    removeCoupon: (c?: CallOptions) =>
      send<Cart>("DELETE", "/cart/coupon", undefined, { ...cartReq, ...c }),
    /** The API has no "empty cart" endpoint: this removes each line (and the coupon) in turn. */
    clear: async (c?: CallOptions): Promise<Cart> => {
      let current = await cart.get(c);
      for (const line of current.items) current = await cart.remove(line.variantId, c);
      if (current.couponCode) current = await cart.removeCoupon(c);
      return current;
    },
    /** Merge the anonymous cart into the signed-in customer's cart (requires a session). */
    merge: async (c?: CallOptions): Promise<Cart> => {
      const cartToken = (await t.getCartToken()) ?? undefined;
      return send<Cart>("POST", "/cart/merge", { cartToken }, { ...cartReq, auth: true, ...c });
    },
    getToken: () => t.getCartToken(),
    setToken: (token: string) => t.setCartToken(token),
    clearToken: () => t.clearCartToken(),
  };

  // ───────── checkout / payments ─────────
  const pendingKeys = new Map<string, string>();
  const checkout = {
    shippingMethods: async (q: { country?: string; subtotal?: string } = {}, c?: CallOptions) =>
      (await get<ListResult<ShippingMethod>>("/checkout/shipping-methods", { ...q }, c)).items,
    summary: (input: CheckoutSummaryInput, c?: CallOptions) =>
      send<CheckoutSummary>("POST", "/checkout/summary", input, { ...cartReq, ...c }),
    /**
     * Place the order. An Idempotency-Key is generated automatically and REUSED if you call
     * `create` again with the same input after a failure (network error, timeout, 5xx), so the
     * order can never be created twice. Pass `idempotencyKey` to control it yourself.
     */
    create: async (
      input: CheckoutCreateInput,
      opts: { idempotencyKey?: string } & CallOptions = {},
    ): Promise<CheckoutResult> => {
      const fingerprint = stableStringify([await t.getCartToken(), input]);
      const key = opts.idempotencyKey ?? pendingKeys.get(fingerprint) ?? newIdempotencyKey();
      pendingKeys.set(fingerprint, key);
      const result = await send<CheckoutResult>("POST", "/checkout/create", input, {
        ...cartReq,
        idempotencyKey: key,
        signal: opts.signal,
      });
      pendingKeys.delete(fingerprint);
      return result;
    },
  };

  const payments = {
    /** Server-side signature check after the provider's client flow (e.g. Razorpay handler). */
    verify: (input: PaymentVerifyInput, c?: CallOptions) =>
      send<PaymentVerifyResult>("POST", "/payments/verify", input, c),
    /** Start a new payment attempt for an unpaid order. */
    retry: (input: PaymentRetryInput, c?: CallOptions) =>
      send<PaymentRetryResult>("POST", "/payments/retry", input, c),
  };

  // ───────── orders / returns ─────────
  const orders = {
    /** Guests identify with the order's email; signed-in owners can omit it. */
    get: (orderNumber: string, email?: string, c?: CallOptions) =>
      get<Order>(`/orders/${enc(orderNumber)}`, { email }, c),
    tracking: (orderNumber: string, email?: string, c?: CallOptions) =>
      get<OrderTracking>(`/orders/${enc(orderNumber)}/tracking`, { email }, c),
    /** URL of the invoice PDF (open/link it; the SDK does not download bytes). */
    invoiceUrl: (orderNumber: string, email?: string): string =>
      t.url(`/orders/${enc(orderNumber)}/invoice.pdf`, { email }),
  };

  const returns = {
    create: (input: ReturnCreateInput, c?: CallOptions) =>
      send<ReturnRequest>("POST", "/returns", input, c),
    get: (id: string, email?: string, c?: CallOptions) =>
      get<ReturnRequest>(`/returns/${enc(id)}`, { email }, c),
    /** Signed-in customer's returns. */
    list: (c?: CallOptions) =>
      get<ListResult<ReturnRequest> & Partial<Paginated<ReturnRequest>>>(
        "/account/returns",
        undefined,
        { auth: true, ...c },
      ),
  };

  // ───────── auth / account ─────────
  const afterAuth = async (s: AuthSession, mergeCart?: boolean) => {
    t.storeSession(s);
    if (mergeCart && (await t.getCartToken())) {
      try {
        await cart.merge();
      } catch {
        /* a failed merge must not fail the login; the anonymous cart token is kept */
      }
    }
    return s;
  };

  const auth = {
    register: async (input: RegisterInput, o: { mergeCart?: boolean } & CallOptions = {}) =>
      afterAuth(
        await send<AuthSession>("POST", "/account/register", input, { signal: o.signal }),
        o.mergeCart,
      ),
    login: async (input: LoginInput, o: { mergeCart?: boolean } & CallOptions = {}) =>
      afterAuth(
        await send<AuthSession>("POST", "/account/login", input, { signal: o.signal }),
        o.mergeCart,
      ),
    /** Ends the session. Local CSRF state is always cleared, even if the request fails. */
    logout: async (c?: CallOptions): Promise<OkResult> => {
      try {
        return await send<OkResult>("POST", "/account/logout", undefined, { auth: true, ...c });
      } catch (e) {
        if (e instanceof CommerceError && e.isUnauthenticated()) return { ok: true };
        throw e;
      } finally {
        t.setCsrfToken(null);
      }
    },
    /** Current customer + (re)loads the CSRF token. Call once on app start to restore a session; rejects with 401 when signed out. */
    me: async (c?: CallOptions) => {
      // A probe: no refresh-and-retry (the refresh endpoint needs the very same cookie), so an
      // anonymous visitor costs exactly one 401.
      const s = await get<AuthSession>("/account/me", undefined, c);
      t.storeSession(s);
      return s;
    },
    refresh: async (c?: CallOptions) => {
      const s = await send<AuthSession>("POST", "/account/refresh", undefined, c);
      t.storeSession(s);
      return s;
    },
    forgotPassword: (email: string, c?: CallOptions) =>
      send<OkResult>("POST", "/account/forgot-password", { email }, c),
    resetPassword: (input: ResetPasswordInput, c?: CallOptions) =>
      send<OkResult>("POST", "/account/reset-password", input, c),
    getCsrfToken: () => t.getCsrfToken(),
    setCsrfToken: (token: string | null) => t.setCsrfToken(token),
  };

  const account = {
    update: async (input: ProfileInput, c?: CallOptions) =>
      (await send<{ customer: Customer }>("PATCH", "/account/me", input, { auth: true, ...c }))
        .customer,
    changePassword: (input: ChangePasswordInput, c?: CallOptions) =>
      send<OkResult>("POST", "/account/change-password", input, { auth: true, ...c }),
    addresses: {
      list: async (c?: CallOptions) =>
        (await get<ListResult<Address>>("/account/addresses", undefined, { auth: true, ...c }))
          .items,
      create: (input: AddressInput, c?: CallOptions) =>
        send<Address>("POST", "/account/addresses", input, { auth: true, ...c }),
      update: (id: string, input: Partial<AddressInput>, c?: CallOptions) =>
        send<Address>("PATCH", `/account/addresses/${enc(id)}`, input, { auth: true, ...c }),
      remove: (id: string, c?: CallOptions) =>
        send<OkResult>("DELETE", `/account/addresses/${enc(id)}`, undefined, { auth: true, ...c }),
    },
    orders: {
      list: (q: { page?: number; pageSize?: number } = {}, c?: CallOptions) =>
        get<Paginated<Order>>("/account/orders", { ...q }, { auth: true, ...c }),
      get: (orderNumber: string, c?: CallOptions) =>
        get<Order>(`/account/orders/${enc(orderNumber)}`, undefined, { auth: true, ...c }),
    },
  };

  // ───────── reviews / blog / seo ─────────
  const reviews = {
    list: (productSlug: string, q: ReviewQuery = {}, c?: CallOptions) =>
      get<ReviewList>(`/products/${enc(productSlug)}/reviews`, { ...q }, c),
    /** New reviews are moderated: the result has `status: "PENDING"`. */
    create: (productSlug: string, input: ReviewInput, c?: CallOptions) =>
      send<ReviewSubmitResult>("POST", `/products/${enc(productSlug)}/reviews`, input, c),
  };

  const blog = {
    list: (q: BlogQuery = {}, c?: CallOptions) =>
      get<Paginated<BlogPostSummary>>("/blog", { ...q }, c),
    getBySlug: (slug: string, c?: CallOptions) => get<BlogPost>(`/blog/${enc(slug)}`, undefined, c),
  };

  const seo = {
    sitemap: (c?: CallOptions) => get<Sitemap>("/seo/sitemap", undefined, c),
    robots: (c?: CallOptions) => get<RobotsInfo>("/seo/robots", undefined, c),
    defaults: (c?: CallOptions) => get<SeoDefaults>("/seo/defaults", undefined, c),
    /** schema.org JSON-LD. `slug` is required for product / blogposting / category. */
    jsonLd: (type: JsonLdType, slug?: string, c?: CallOptions) =>
      get<JsonLd>("/seo/jsonld", { type, slug }, c),
    /** Resolved meta (title template applied) for a CMS page. */
    page: (slug: string, c?: CallOptions) =>
      get<ResolvedSeo>(`/seo/page/${enc(slug)}`, undefined, c),
  };

  return {
    store,
    products,
    categories,
    collections,
    navigation,
    pages,
    filters,
    cart,
    checkout,
    payments,
    orders,
    returns,
    auth,
    account,
    reviews,
    blog,
    seo,
    /** Absolute API base (`…/api/v1`) in use. */
    apiBase: t.apiBase,
  };
}

export type CommerceClient = ReturnType<typeof createCommerceClient>;
export type { CommerceClientOptions };
export type { Review };
