# Storefront integration guide

Build any storefront (React, Vue, Next.js, Astro, mobile web...) on top of a Kash Commerce backend with the
**`@kash-commerce/storefront-sdk`** package. You should be able to go from nothing to browse → cart → checkout
in **30-60 minutes**. A complete reference implementation lives in
[`examples/demo-storefront`](../examples/demo-storefront) (Vite + React) and uses _only_ the SDK.

```
YOUR STOREFRONT  ->  @kash-commerce/storefront-sdk  ->  /api/v1 (public API)  ->  Postgres / providers
```

- Zero runtime dependencies, ESM, TypeScript types for every response.
- Works in browsers, Node 18+ and SSR. `fetch` is injectable.
- Public API only - **no secrets, no admin endpoints**. Prices are decimal strings (`"24.00"`), never floats.

## 1. Install

Inside this monorepo add the workspace dependency (`"@kash-commerce/storefront-sdk": "*"`). For a storefront in
its own repository, build the package once and install the tarball (or publish it to your private registry):

```bash
npm run build -w @kash-commerce/storefront-sdk
npm pack -w @kash-commerce/storefront-sdk          # -> kash-commerce-storefront-sdk-0.1.0.tgz
npm install ../path/to/kash-commerce-storefront-sdk-0.1.0.tgz
```

`package.json` exports a `development` condition (TypeScript source, used by workspace tooling) and `dist/`
(ESM + `.d.ts`) for everything else.

## 2. Configure

A storefront needs exactly **one** setting: the API origin.

```bash
# .env
VITE_COMMERCE_API_URL=https://api.myshop.com      # origin only, no /api/v1
```

```ts
// commerce.ts
import { createCommerceClient } from "@kash-commerce/storefront-sdk";

export const commerce = createCommerceClient({
  baseUrl: import.meta.env.VITE_COMMERCE_API_URL, // "/api/v1" is appended for you
});
```

All options:

| Option           | Default                   | Purpose                                                                                          |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `baseUrl`        | required                  | API origin. `""` works behind a same-origin reverse proxy.                                       |
| `fetch`          | `globalThis.fetch`        | Inject a custom/instrumented fetch (tests, polyfills, cookie jars).                              |
| `credentials`    | `"include"`               | Cookie mode for the customer session. Keep `include` for cross-origin APIs.                      |
| `cartStorage`    | localStorage, else memory | Where the anonymous cart token lives. Implement `{ get, set, remove }` for cookies/AsyncStorage. |
| `headers`        | none                      | Static object or function returning extra headers (e.g. forward `cookie` during SSR).            |
| `timeoutMs`      | `15000`                   | Per-attempt timeout. `0` disables.                                                               |
| `retry`          | `{ retries: 2 }`          | Retries for **idempotent GETs only** (network errors, 429, 502/503/504, 500). `false` disables.  |
| `onUnauthorized` | none                      | Called when an authenticated call gets 401 and the one-time session refresh also failed.         |

## 3. Auth, cookies, CSRF and CORS

Customer accounts are **optional** (guest checkout is supported). A session is an opaque `httpOnly` cookie
(`kc_customer`, path `/api/v1`, `SameSite=Lax`) plus a per-session **CSRF token** that the API returns from
`register`, `login`, `refresh` and `me`.

The SDK handles this for you:

- cookies are sent with `credentials: "include"`;
- the CSRF token is kept **in memory** and sent as `X-CSRF-Token` on every unsafe (POST/PATCH/PUT/DELETE) request;
- if the token is unknown (page reload) the SDK loads it via `GET /account/me` before the first account mutation;
- on `401` an account call refreshes the session **once** (`POST /account/refresh`, shared between concurrent
  calls) and replays the original request; on `403 CSRF_FAILED` it reloads the token once;
- **call `commerce.auth.me()` once at app start** to restore a session after a reload. It rejects with `401` when
  the visitor is signed out - that is normal.

```ts
const { customer } = await commerce.auth.login({ email, password }, { mergeCart: true });
// mergeCart moves the anonymous cart into the customer's cart (cart.merge())
await commerce.auth.logout();
```

### CORS and cookies in production

Browsers only attach the cookie if the request is **same-site** with the API.

1. **Allowlist your storefront origin** in the API's `CORS_ORIGINS` env (comma separated, no wildcards, e.g.
   `https://shop.myshop.com`). The API answers with `Access-Control-Allow-Credentials: true` and allows the headers
   `Content-Type, X-CSRF-Token, X-Request-Id, Idempotency-Key, X-Cart-Token`.
2. **Keep storefront and API on the same registrable domain** (`shop.myshop.com` + `api.myshop.com`), or proxy the
   API under the storefront origin (`/api/v1/*` → API; then use `baseUrl: ""` or the storefront origin). Cookies are
   `SameSite=Lax`, so a storefront on `myshop.com` and an API on `someotherdomain.io` will **not** receive the
   session cookie. Anonymous browsing and carts still work cross-site because they use headers, not cookies.
3. Set `COOKIE_SECURE=true` (HTTPS) and, for sub-domains, `COOKIE_DOMAIN=.myshop.com` on the API.
4. Local development: `localhost:5173` (storefront) → `localhost:4000` (API) is same-site; just add
   `http://localhost:5173` to `CORS_ORIGINS`.

## 4. Browsing the catalogue

```ts
const settings = await commerce.store.getSettings(); // name, currency, locale, feature flags
const page = await commerce.products.list({
  category: "t-shirts", // includes sub-categories
  sort: "price_asc", // newest | price_asc | price_desc | title | featured
  page: 1,
  pageSize: 12,
  minPrice: "10",
  maxPrice: "50",
  inStock: true,
  attributes: { color: ["black", "navy"] }, // -> attr.color=black,navy
  properties: { fit: ["slim"] }, // -> prop.fit=slim
}); // Paginated<ProductListItem>
const product = await commerce.products.getBySlug("classic-tee"); // variants, options, related
const results = await commerce.products.search("hoodie", { pageSize: 8 });
for await (const p of commerce.products.listAll({ category: "sale" })) {
  /* every page, lazily */
}
```

`Paginated<T>` is `{ items, page, pageSize, total, totalPages }`; `hasNextPage(p)` is exported.

**Variants.** `product.options` lists the selectable attributes (`Color: Black, White...`). Each entry in
`product.variants` has `attributes[]` (`attributeSlug` + `valueSlug`), `price`, `compareAtPrice`, `inStock` and a
capped `available`. Pick the variant whose attributes match the shopper's choices; the cart takes a **variant id**.

**Categories / collections / pages.**

```ts
await commerce.categories.list({ counts: true }); // nested tree
await commerce.categories.get("t-shirts"); // breadcrumb, children, banner, seo
await commerce.collections.list();
await commerce.collections.get("summer", { page: 1 });
```

## 5. Faceted filters

`filters.get()` returns the groups the merchant configured in the admin (per category, with inheritance) and
**live counts** that ignore each group's own selection. Render them generically:

```ts
const { groups } = await commerce.filters.get({
  category: "t-shirts",
  selections: { attributes: { color: ["black"] }, minPrice: "20" }, // current selections (optional)
  device: "mobile", // optional: hides desktop-only groups
});
```

Each group: `{ key, label, type: "multi" | "single" | "range" | "boolean", open, options[], range? }` with options
`{ value, label, count, selected, meta? }`. **`key` is the query-string key**:

| `key`           | Write it as                                     | Notes                             |
| --------------- | ----------------------------------------------- | --------------------------------- |
| `attr.<slug>`   | `attributes: { <slug>: [value, ...] }`          | `meta` can carry swatch colours   |
| `prop.<key>`    | `properties: { <key>: [value, ...] }`           |                                   |
| `tag`           | `tag: [...]`                                    |                                   |
| `collection`    | `collection: "<slug>"`                          | single select                     |
| `category`      | `category: "<slug>"` (navigate to the category) | options are child categories      |
| `price` (range) | `minPrice` / `maxPrice`                         | `range` has the catalogue min/max |
| `inStock`       | `inStock: true`                                 | boolean                           |

The simplest design (used by the demo): keep the filters in the URL query string, use `parseProductQuery()` to
turn `location.search` into a `ProductQuery`, pass it to both `products.list()` and `filters.get({ selections })`.

## 6. Cart

The cart is identified by an anonymous **cart token** (`X-Cart-Token`). The SDK stores it in `cartStorage`, sends it
on cart/checkout calls and refreshes it from every response - you never touch it.

```ts
await commerce.cart.add({ variantId, quantity: 1 }); // creates the cart on first add
const cart = await commerce.cart.get(); // items, subtotal, discount, tax, total, warnings[]
await commerce.cart.update(variantId, 3); // absolute quantity, 0 removes
await commerce.cart.remove(variantId);
await commerce.cart.applyCoupon("SAVE10"); // 422 with a precise message if invalid
await commerce.cart.removeCoupon();
await commerce.cart.clear(); // removes each line (no bulk endpoint)
await commerce.cart.merge(); // anonymous -> signed-in customer cart
```

`cart.warnings` reports lines that became unavailable (`OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `UNAVAILABLE`);
show them before checkout. Adding more than is in stock throws a `CommerceError` where `isOutOfStock()` is true.
The cart total excludes shipping - it is added at checkout.

## 7. Checkout

```ts
// 1. shipping options for the destination
const methods = await commerce.checkout.shippingMethods({ country: "US", subtotal: cart.subtotal });

// 2. authoritative totals (shipping, tax, coupon) for the address + method
const summary = await commerce.checkout.summary({
  shippingAddress,
  shippingMethodCode: methods[0].code,
});

// 3. place the order
const result = await commerce.checkout.create({
  email, // required for guests, defaults to the signed-in customer's
  phone,
  shippingAddress, // { fullName, line1, city, postalCode, country (ISO-2), ... }
  billingAddress, // optional, defaults to shipping
  shippingMethodCode: methods[0].code,
  paymentProvider: "MANUAL", // optional: omit for the store's active online provider
});
```

`create()` returns `{ order, paymentRequired, paymentProvider, providerAvailable, clientPayload, paymentError? }`.

**Idempotency is automatic.** The SDK generates an `Idempotency-Key`, and **reuses it if you call `create()` again
with the same input** after a network error/timeout/5xx, so the order can never be placed twice. The API replays the
original response (`idempotentReplay: true`). The SDK never auto-retries a POST. Pass
`create(input, { idempotencyKey })` to manage keys yourself (store it in `sessionStorage` if the page may reload).

Server-side rules you may hit: guest checkout disabled (401), phone required, minimum order amount (422 with
`details.minOrderAmount`), stock changed since the cart (409 `OUT_OF_STOCK`, `details.items[]`).

## 8. Payments

Branch on the `create()` result:

```ts
if (!result.paymentRequired) {
  // MANUAL (cash on delivery) or a free order: the order is already CONFIRMED.
  goto(`/order/${result.order.orderNumber}?email=${email}`);
} else
  switch (result.paymentProvider) {
    /* see below */
  }
```

### MANUAL / COD

Nothing to do - the order is confirmed immediately (`paymentRequired: false`).

### Razorpay

`clientPayload = { keyId, providerOrderId, amount (integer minor units), currency, name? }`.

```ts
const p = result.clientPayload!;
const rzp = new window.Razorpay({
  key: p.keyId,
  order_id: p.providerOrderId,
  amount: p.amount,
  currency: p.currency,
  prefill: { email },
  handler: async (r) => {
    await commerce.payments.verify({
      orderNumber: result.order.orderNumber,
      email,
      providerOrderId: r.razorpay_order_id,
      providerPaymentId: r.razorpay_payment_id,
      signature: r.razorpay_signature,
    });
    goto(`/order/${result.order.orderNumber}?email=${email}`);
  },
});
rzp.open(); // load https://checkout.razorpay.com/v1/checkout.js first
```

`payments.verify()` makes the **server** check the signature with the secret key (the browser never sees it); the
API also receives the provider webhook, so the order is paid even if the shopper closes the tab. If the attempt
fails or is abandoned use `commerce.payments.retry({ orderNumber, email })` to get a fresh `clientPayload`.
A runnable version is in `examples/demo-storefront/src/lib/payments.ts`.

### MOCK (development only)

Non-production APIs may run `PAYMENT_PROVIDER=MOCK`: `clientPayload = { mock: true, providerOrderId, amount, currency }`.
The mock "signature" is an HMAC with a **public development secret**, so the demo can sign it in the browser
("Simulate payment", clearly labelled DEMO ONLY). The mock provider is rejected in production by the API. Use MANUAL
for demos that must not depend on this.

> The payments / returns / invoices / tracking endpoints (`/payments/verify`, `/payments/retry`, `/returns`,
> `/account/returns`, `/orders/:n/tracking`, `/orders/:n/invoice.pdf`) follow the agreed API contract. The SDK
> passes their JSON through; their response types are intentionally loose until the API settles.

## 9. Orders, returns, invoices

```ts
await commerce.orders.get("KC-100001", "guest@example.com"); // guests: order number + email
await commerce.account.orders.list({ page: 1 }); // signed-in history
await commerce.orders.tracking("KC-100001", email);
const url = commerce.orders.invoiceUrl("KC-100001", email); // <a href={url}>Invoice (PDF)</a>
await commerce.returns.create({
  orderNumber,
  email,
  reason: "SIZE",
  items: [{ orderItemId, quantity: 1 }],
});
await commerce.returns.get(id, email);
await commerce.returns.list(); // list = signed-in customer
```

Wrong order-number/email combinations return `404` (not 403) so orders cannot be enumerated.

## 10. Navigation

```ts
const header = await commerce.navigation.get(); // "header" menu; also "footer", or any key
const all = await commerce.navigation.getAll();
```

Items are a tree `{ id, label, type, url, badge, promo, showDesktop, showMobile, openInNewTab, children[] }`. The API
resolves `CATEGORY` / `COLLECTION` / `PAGE` items into storefront paths:

| item type     | `url`                                                         |
| ------------- | ------------------------------------------------------------- |
| `CATEGORY`    | `/category/<slug>`                                            |
| `COLLECTION`  | `/collection/<slug>`                                          |
| `PAGE`        | `/pages/<slug>`                                               |
| `LINK`/`MEGA` | whatever the merchant entered (relative path or absolute URL) |

Implement those routes (the demo does) and nav links just work. `promo` (title/subtitle/url/`mediaUrl`) is the
optional mega-menu feature tile. Hide items with `showDesktop`/`showMobile` per breakpoint.
An unconfigured header/footer is an empty menu, not an error.

## 11. CMS pages and the section contract

```ts
const page = await commerce.pages.get("home"); // 404 -> CommerceError.isNotFound()
page.sections.map((s) => render(s)); // already filtered (enabled, scheduled) and ordered
```

Each section is `{ id, type, key, sortOrder, content }`. Render by `type`; **unknown types must degrade gracefully**
(the demo prints the JSON). Media: every `...MediaId` field has a resolved `...Url` sibling.

| `type`          | `content` (essentials)                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `HERO`          | `heading, subheading?, image?, cta?, secondaryCta?, align, overlayOpacity?`                                     |
| `PROMO_BANNER`  | `text, cta?, image?, backgroundColor?, textColor?`                                                              |
| `TEXT`          | `heading?, body (sanitised HTML), align`                                                                        |
| `RICH_TEXT`     | `html` (sanitised HTML)                                                                                         |
| `IMAGE`         | `image, linkUrl?, caption?`                                                                                     |
| `PRODUCT_GRID`  | `heading?, limit, cta?`, **`items: ProductCard[]`** (resolved by the API: slug, title, price, imageUrl, rating) |
| `CATEGORY_GRID` | `heading?, limit`, **`items`** (`name, slug, url, imageUrl`)                                                    |
| `REVIEWS`       | `heading?, limit`, **`items`** (`authorName, rating, title, body, product?`)                                    |
| `BLOG_PREVIEW`  | `heading?, limit`, **`items`** (`slug, title, excerpt, coverUrl, publishedAt`)                                  |
| `CUSTOM_JSON`   | free-form object (up to 64 KB) - your storefront defines the meaning                                            |

`image` is `{ desktopMediaUrl, mobileMediaUrl?, alt? }` - use `<picture>` with the mobile URL below your breakpoint.
HTML fields are sanitised by the API on save; render them with `innerHTML` / `dangerouslySetInnerHTML`. See
`examples/demo-storefront/src/components/Sections.tsx` for a complete renderer. New section types appear without
SDK changes (they arrive as `CUSTOM_JSON`-style content you can render or ignore).

## 12. Reviews and blog

```ts
const { items, aggregate } = await commerce.reviews.list("classic-tee", {
  sort: "highest",
  pageSize: 10,
});
const r = await commerce.reviews.create("classic-tee", { rating: 5, body, authorName, email });
// r.status === "PENDING": reviews are moderated, tell the shopper it will appear once approved.
// A second review from the same email for the same product -> 409 CONFLICT.
const posts = await commerce.blog.list({ page: 1, tag: "news" });
const post = await commerce.blog.getBySlug("welcome"); // body is sanitised HTML
```

Reviews/blog can be switched off in the admin (`settings.features.reviews|blog`); the API then answers 404.

## 13. SEO and JSON-LD

```ts
const ld = await commerce.seo.jsonLd("product", "classic-tee"); // also "blogposting", "category" (breadcrumbs), "organization"
// <script type="application/ld+json">{serializeJsonLd(ld)}</script>
const meta = await commerce.seo.page("about"); // resolved title (template applied), description, canonical, robots
const defaults = await commerce.seo.defaults(); // titleTemplate, defaultTitle, siteUrl, robots
const sitemap = await commerce.seo.sitemap(); // { products, categories, collections, pages, blog } of { slug, updatedAt }
const robots = await commerce.seo.robots(); // { allow, disallow[], sitemapPath, siteUrl }
```

**Always inject JSON-LD with `serializeJsonLd()`** (exported by the SDK): it escapes `<`, `>`, `&` so catalogue content
cannot break out of the script tag. Absolute URLs in the JSON-LD use the admin-configured `siteUrl`
(SEO settings) - set it to your storefront origin. Generate your `sitemap.xml` / `robots.txt` from the two
endpoints at build time or in a server route; the API returns slugs, you add your own URL pattern.

## 14. Error handling

Every failure is a `CommerceError`:

```ts
try {
  await commerce.cart.add({ variantId, quantity: 50 });
} catch (e) {
  if (!(e instanceof CommerceError)) throw e;
  e.status; // HTTP status, 0 for network/timeout
  e.code; // BAD_REQUEST | VALIDATION_ERROR | UNAUTHENTICATED | FORBIDDEN | NOT_FOUND | CONFLICT |
  // RATE_LIMITED | OUT_OF_STOCK | PAYMENT_FAILED | PROVIDER_ERROR | CSRF_FAILED |
  // ACCOUNT_LOCKED | INTERNAL_ERROR | NETWORK_ERROR | TIMEOUT | ABORTED | INVALID_RESPONSE
  e.message;
  e.details;
  e.requestId; // quote requestId to the merchant when reporting a bug
  e.isOutOfStock();
  e.isValidation();
  e.isNotFound();
  e.isRateLimited();
  e.isUnauthenticated();
  e.isNetworkError();
  e.fieldErrors(); // [{ path: "email", message: "Invalid email" }] for 422s
  e.isRetryable; // safe to retry an idempotent request
}
```

Non-JSON error bodies (a proxy's 502 HTML page) are normalised into the same shape. Pass
`{ signal: abortController.signal }` as the last argument of any call to cancel it.

## 15. SSR and Next.js

- Create the client **per request** on the server (it holds the in-memory CSRF token and cart token) and a single
  shared one in the browser. On the server the default `cartStorage` is memory.
- Anonymous catalogue pages (`products`, `categories`, `pages`, `navigation`, `seo`) are cacheable. Responses carry
  `Cache-Control` hints; with Next.js `fetch` caching pass your own `fetch` wrapper:
  `createCommerceClient({ baseUrl, fetch: (u, i) => fetch(u, { ...i, next: { revalidate: 60 } }) })`.
- To render account pages on the server, forward the browser's cookie:
  `createCommerceClient({ baseUrl, headers: () => ({ cookie: cookies().toString() }) })`, then call `auth.me()`.
  Server components must not store the CSRF token in module scope.
- Do **not** call `cart.*` or `checkout.*` during SSR for anonymous users (the cart token lives in the browser);
  do them from client components.
- Node < 18 has no `fetch`: pass one (`undici`, `node-fetch`).

```ts
// app/lib/commerce.ts (Next.js app router)
import { createCommerceClient, createMemoryCartStorage } from "@kash-commerce/storefront-sdk";
export const serverCommerce = () =>
  createCommerceClient({
    baseUrl: process.env.COMMERCE_API_URL!,
    cartStorage: createMemoryCartStorage(),
  });
```

## 16. Versioning policy

The public API is versioned in the path: **`/api/v1`**. Within v1 changes are **additive only**: new endpoints, new
optional request fields and new response fields. Existing fields are never removed or retyped, error codes are
never repurposed, and new enum values (section types, order statuses) may appear - make your UI tolerate unknown
values. Breaking changes ship as `/api/v2` alongside v1. The SDK follows semver; a minor release adds methods/types,
a major release is needed only if v2 is adopted.

## 17. Method reference

All methods return Promises and accept an optional trailing `{ signal }`. Return types are exported.

| Method                                                                    | HTTP                                                        | Returns                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `store.getSettings()`                                                     | `GET /store/settings`                                       | `StoreSettings`                                |
| `products.list(query)`                                                    | `GET /products`                                             | `Paginated<ProductListItem>`                   |
| `products.getBySlug(slug)`                                                | `GET /products/:slug`                                       | `ProductDetail`                                |
| `products.search(q, opts)`                                                | `GET /products/search`                                      | `Paginated<ProductListItem>`                   |
| `products.listAll(query, {maxPages})`                                     | `GET /products` (paged)                                     | `AsyncGenerator<ProductListItem>`              |
| `categories.list({counts})`                                               | `GET /categories`                                           | `CategoryNode[]`                               |
| `categories.get(slug)`                                                    | `GET /categories/:slug`                                     | `CategoryDetail`                               |
| `collections.list()` / `collections.get(slug, query)`                     | `GET /collections[/:slug]`                                  | `CollectionSummary[]` / `CollectionDetail`     |
| `navigation.get(menu = "header")` / `navigation.getAll()`                 | `GET /navigation`                                           | `NavigationMenu` / `NavigationMenu[]`          |
| `pages.list()` / `pages.get(slug)`                                        | `GET /pages[/:slug]`                                        | `PageSummary[]` / `Page`                       |
| `filters.get({category, selections, device})`                             | `GET /filters`                                              | `FiltersResponse`                              |
| `cart.get()`                                                              | `GET /cart`                                                 | `Cart`                                         |
| `cart.add({variantId, quantity})`                                         | `POST /cart/items`                                          | `Cart`                                         |
| `cart.update(variantId, quantity)`                                        | `PATCH /cart/items/:variantId`                              | `Cart`                                         |
| `cart.remove(variantId)`                                                  | `DELETE /cart/items/:variantId`                             | `Cart`                                         |
| `cart.applyCoupon(code)` / `cart.removeCoupon()`                          | `POST` / `DELETE /cart/coupon`                              | `Cart`                                         |
| `cart.clear()`                                                            | `GET` + `DELETE` per line                                   | `Cart`                                         |
| `cart.merge()`                                                            | `POST /cart/merge`                                          | `Cart`                                         |
| `cart.getToken()` / `setToken(t)` / `clearToken()`                        | local                                                       | cart token helpers                             |
| `checkout.shippingMethods({country, subtotal})`                           | `GET /checkout/shipping-methods`                            | `ShippingMethod[]`                             |
| `checkout.summary(input)`                                                 | `POST /checkout/summary`                                    | `CheckoutSummary`                              |
| `checkout.create(input, {idempotencyKey})`                                | `POST /checkout/create`                                     | `CheckoutResult`                               |
| `payments.verify(input)`                                                  | `POST /payments/verify`                                     | `PaymentVerifyResult`                          |
| `payments.retry(input)`                                                   | `POST /payments/retry`                                      | `PaymentRetryResult`                           |
| `orders.get(orderNumber, email?)`                                         | `GET /orders/:orderNumber`                                  | `Order`                                        |
| `orders.tracking(orderNumber, email?)`                                    | `GET /orders/:orderNumber/tracking`                         | `OrderTracking`                                |
| `orders.invoiceUrl(orderNumber, email?)`                                  | builds `/orders/:n/invoice.pdf?email=`                      | `string` (URL)                                 |
| `returns.create(input)` / `returns.get(id, email?)` / `returns.list()`    | `POST /returns`, `GET /returns/:id`, `GET /account/returns` | `ReturnRequest` / `ReturnRequest` / list       |
| `auth.register(input, {mergeCart})`                                       | `POST /account/register`                                    | `AuthSession`                                  |
| `auth.login(input, {mergeCart})`                                          | `POST /account/login`                                       | `AuthSession`                                  |
| `auth.logout()`                                                           | `POST /account/logout`                                      | `{ ok }`                                       |
| `auth.me()`                                                               | `GET /account/me`                                           | `AuthSession` (rejects 401 when signed out)    |
| `auth.refresh()`                                                          | `POST /account/refresh`                                     | `AuthSession`                                  |
| `auth.forgotPassword(email)` / `auth.resetPassword({token, newPassword})` | `POST /account/forgot-password`, `/reset-password`          | `{ ok }`                                       |
| `auth.getCsrfToken()` / `auth.setCsrfToken(t)`                            | local                                                       | CSRF helpers (SSR hydration)                   |
| `account.update(profile)`                                                 | `PATCH /account/me`                                         | `Customer`                                     |
| `account.changePassword({currentPassword, newPassword})`                  | `POST /account/change-password`                             | `{ ok }`                                       |
| `account.addresses.list/create/update/remove`                             | `/account/addresses[/:id]`                                  | `Address[]` / `Address` / `Address` / `{ ok }` |
| `account.orders.list(query)` / `account.orders.get(orderNumber)`          | `GET /account/orders[/:orderNumber]`                        | `Paginated<Order>` / `Order`                   |
| `reviews.list(productSlug, query)`                                        | `GET /products/:slug/reviews`                               | `ReviewList` (with `aggregate`)                |
| `reviews.create(productSlug, input)`                                      | `POST /products/:slug/reviews`                              | `ReviewSubmitResult`                           |
| `blog.list(query)` / `blog.getBySlug(slug)`                               | `GET /blog[/:slug]`                                         | `Paginated<BlogPostSummary>` / `BlogPost`      |
| `seo.sitemap()` / `seo.robots()` / `seo.defaults()`                       | `GET /seo/sitemap`, `/robots`, `/defaults`                  | `Sitemap` / `RobotsInfo` / `SeoDefaults`       |
| `seo.jsonLd(type, slug?)`                                                 | `GET /seo/jsonld`                                           | `JsonLd`                                       |
| `seo.page(slug)`                                                          | `GET /seo/page/:slug`                                       | `ResolvedSeo`                                  |

Helpers: `formatMoney(amount, currency, locale)`, `toMinorUnits`, `fromMinorUnits`, `productQueryParams`,
`parseProductQuery`, `serializeJsonLd`, `hasNextPage`, `paginate`, `isCommerceError`, `createMemoryCartStorage`,
`createWebCartStorage`, `createDefaultCartStorage`.

## 18. Testing your integration

- Unit tests: inject a fake `fetch` (`createCommerceClient({ baseUrl: "http://x", fetch: fake })`) - see
  `packages/storefront-sdk/tests/helpers.ts`.
- Against a real API: `COMMERCE_API_URL=http://localhost:4000 npm test -w @kash-commerce/storefront-sdk` runs the
  contract suite (catalogue, cart, guest checkout with idempotency, customer session + CSRF, reviews, SEO).
- Seed a local API for the demo with admin credentials: `node examples/demo-storefront/scripts/seed.mjs`
  (see its header for the env vars).

## 19. Current API limitations to be aware of

- `store.getSettings()` exposes `logoMediaId` / `faviconMediaId` but no resolved URL, so a storefront cannot render
  the store logo from the public API alone (the demo shows the store name).
- There is no bulk "empty cart" endpoint; `cart.clear()` removes lines one by one.
- `CATEGORY` navigation items resolve to `/category/<slug>` etc.; the storefront owns the routing for those paths.
