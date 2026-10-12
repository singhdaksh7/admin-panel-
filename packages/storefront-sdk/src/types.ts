/**
 * Public API types. They mirror the JSON the Kash Commerce API (`/api/v1`) returns.
 * Rules: money is ALWAYS a decimal string ("12.50"); dates are ISO-8601 strings; the API only adds
 * fields within v1, so treat unknown extra properties as forward-compatible.
 */

// ───────────────────────── shared ─────────────────────────

export type Money = string;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListResult<T> {
  items: T[];
}

export interface OkResult {
  ok: true;
}

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "OUT_OF_STOCK"
  | "PAYMENT_FAILED"
  | "PROVIDER_ERROR"
  | "CSRF_FAILED"
  | "ACCOUNT_LOCKED"
  | "INTERNAL_ERROR"
  // client-side codes
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "INVALID_RESPONSE"
  | (string & {});

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}

// ───────────────────────── store ─────────────────────────

export interface StoreAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface FeatureFlags {
  customerAccounts: boolean;
  guestCheckout: boolean;
  reviews: boolean;
  blog: boolean;
  coupons: boolean;
  inventory: boolean;
}

export interface StoreSettings {
  name: string;
  legalName: string | null;
  logoMediaId: string | null;
  faviconMediaId: string | null;
  /** Resolved public URLs of the logo / favicon (null when not set). */
  logoUrl: string | null;
  faviconUrl: string | null;
  supportEmail: string | null;
  phone: string | null;
  address: StoreAddress | null;
  currency: string;
  locale: string;
  timezone: string;
  tax: { mode: "NONE" | "EXCLUSIVE" | "INCLUSIVE" | "INDIA_GST"; pricesIncludeTax: boolean };
  features: FeatureFlags;
  social: Record<string, string> | null;
}

// ───────────────────────── catalog ─────────────────────────

export interface ProductImage {
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

export interface Rating {
  average: number;
  count: number;
}

export interface ProductListItem {
  id: string;
  title: string;
  slug: string;
  shortDescription: string | null;
  /** lowest active variant price; null when no purchasable variant */
  price: Money | null;
  compareAtPrice: Money | null;
  currency: string;
  image: string | null;
  images: ProductImage[];
  category: { name: string; slug: string } | null;
  inStock: boolean;
  isFeatured: boolean;
  isNew: boolean;
  rating: Rating;
}

export interface VariantAttribute {
  attribute: string;
  attributeSlug: string;
  value: string;
  valueSlug: string;
}

export interface ProductVariant {
  id: string;
  sku: string;
  title: string | null;
  price: Money;
  compareAtPrice: Money | null;
  weightGrams: number | null;
  isDefault: boolean;
  attributes: VariantAttribute[];
  inStock: boolean;
  /** capped (20) stock figure; do not show as an exact count */
  available: number;
  image: string | null;
}

export interface ProductOption {
  attribute: string;
  attributeSlug: string;
  values: Array<{ value: string; slug: string }>;
}

export interface ProductSeo {
  title?: string | null;
  description?: string | null;
  canonicalUrl?: string | null;
  ogImageMediaId?: string | null;
  noindex?: boolean | null;
  nofollow?: boolean | null;
}

export interface ProductDetail extends ProductListItem {
  description: string | null;
  brand: string | null;
  seo: ProductSeo | null;
  properties: Record<string, unknown> | null;
  tags: Array<{ name: string; slug: string }>;
  attributes: VariantAttribute[];
  options: ProductOption[];
  variants: ProductVariant[];
  related: ProductListItem[];
}

export type ProductSort = "newest" | "price_asc" | "price_desc" | "title" | "featured";

export interface ProductQuery {
  page?: number;
  pageSize?: number;
  /** free-text (used by `search`; also accepted on list) */
  q?: string;
  category?: string;
  collection?: string;
  tag?: string | string[];
  minPrice?: string | number;
  maxPrice?: string | number;
  inStock?: boolean;
  sort?: ProductSort;
  /** attribute slug -> value slugs => `attr.<slug>=a,b` */
  attributes?: Record<string, string[]>;
  /** product property key -> values => `prop.<key>=a,b` */
  properties?: Record<string, string[] | string>;
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  sortOrder: number;
  productCount?: number;
  children: CategoryNode[];
}

export interface CategoryDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  banner: string | null;
  seo: ProductSeo | null;
  breadcrumb: Array<{ id: string; name: string; slug: string }>;
  children: Array<{ id: string; name: string; slug: string; image: string | null }>;
}

export interface CollectionSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
}

export interface CollectionDetail extends CollectionSummary {
  seo: ProductSeo | null;
  products: Paginated<ProductListItem>;
}

// ───────────────────────── navigation / pages ─────────────────────────

export interface NavigationPromo {
  title?: string;
  subtitle?: string;
  url?: string;
  ctaLabel?: string;
  mediaId?: string;
  mediaUrl?: string | null;
  [k: string]: unknown;
}

export interface NavigationItem {
  id: string;
  label: string;
  type: "LINK" | "CATEGORY" | "COLLECTION" | "PAGE" | "MEGA" | (string & {});
  /** relative storefront path (`/category/x`, `/collection/x`, `/pages/x`) or absolute URL */
  url: string | null;
  badge: string | null;
  promo: NavigationPromo | null;
  showDesktop: boolean;
  showMobile: boolean;
  openInNewTab: boolean;
  children: NavigationItem[];
}

export interface NavigationMenu {
  key: string;
  name: string;
  items: NavigationItem[];
}

export interface PageSummary {
  slug: string;
  title: string;
}

export interface Responsive {
  desktopMediaId?: string;
  desktopMediaUrl?: string | null;
  mobileMediaId?: string;
  mobileMediaUrl?: string | null;
  alt?: string;
}
export interface Cta {
  label: string;
  url: string;
}

export interface ProductCard {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  shortDescription: string | null;
  price: Money | null;
  compareAtPrice: Money | null;
  imageUrl: string | null;
  isNew: boolean;
  isFeatured: boolean;
  rating: Rating;
}

export interface CategoryCard {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  url: string;
  imageUrl: string | null;
}

export interface BlogCard {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  authorName: string | null;
  tags: string[];
  coverUrl: string | null;
  publishedAt: string;
}

export interface ReviewCard {
  id: string;
  authorName: string;
  rating: number;
  title: string | null;
  body: string;
  verifiedPurchase: boolean;
  createdAt: string;
  product?: { slug: string; title: string };
}

/** Content per CMS section type. The `type` discriminates `content`. */
export interface SectionContentMap {
  HERO: {
    heading: string;
    subheading?: string;
    image?: Responsive;
    cta?: Cta;
    secondaryCta?: Cta;
    align: "left" | "center" | "right";
    overlayOpacity?: number;
  };
  PROMO_BANNER: {
    text: string;
    cta?: Cta;
    image?: Responsive;
    backgroundColor?: string;
    textColor?: string;
  };
  TEXT: { heading?: string; body: string; align: "left" | "center" | "right" };
  IMAGE: { image: Responsive; linkUrl?: string; caption?: string };
  PRODUCT_GRID: { heading?: string; limit: number; cta?: Cta; items: ProductCard[] };
  CATEGORY_GRID: { heading?: string; limit: number; items: CategoryCard[] };
  RICH_TEXT: { html: string };
  REVIEWS: { heading?: string; limit: number; items: ReviewCard[] };
  BLOG_PREVIEW: { heading?: string; limit: number; items: BlogCard[] };
  CUSTOM_JSON: Record<string, unknown>;
}

export type SectionType = keyof SectionContentMap;

export type PageSection = {
  [K in SectionType]: {
    id: string;
    type: K;
    key: string | null;
    sortOrder: number;
    content: SectionContentMap[K];
  };
}[SectionType];

export interface PageSeoMeta extends ProductSeo {
  ogImageUrl?: string | null;
}

export interface Page {
  slug: string;
  title: string;
  seo: PageSeoMeta | null;
  sections: PageSection[];
}

// ───────────────────────── filters ─────────────────────────

export type FilterGroupType = "multi" | "single" | "range" | "boolean";

export interface FilterOption {
  value: string;
  label: string;
  count: number;
  selected: boolean;
  meta?: unknown;
}

export interface FilterGroup {
  id: string;
  /** CATEGORY | COLLECTION | PRICE | STOCK | ATTRIBUTE | TAG | PROPERTY */
  source: string;
  /**
   * The query key this group maps to: `category`, `collection`, `tag`, `price`, `inStock`,
   * `attr.<slug>` or `prop.<key>`.
   */
  key: string;
  label: string;
  type: FilterGroupType;
  open: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  options: FilterOption[];
  range?: { min: string | null; max: string | null };
}

export interface FiltersResponse {
  category: { id: string; name: string; slug: string } | null;
  groups: FilterGroup[];
}

export interface FiltersQuery extends ProductQuery {
  device?: "desktop" | "mobile";
}

/** Selections accepted by `filters.get` – same grammar as the product query. */
export type FilterSelections = Omit<ProductQuery, "page" | "pageSize" | "sort" | "category">;

// ───────────────────────── cart ─────────────────────────

export type LineProblem = "NOT_FOUND" | "UNAVAILABLE" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK";

export interface TaxBreakdownLine {
  name: string;
  rate: number;
  amount: Money;
}

export interface PricedLineDto {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  sku: string;
  imageUrl: string | null;
  attributes: Array<{ name: string; value: string }>;
  unitPrice: Money;
  quantity: number;
  discount: Money;
  taxRate: number;
  tax: Money;
  lineTotal: Money;
}

export interface CartWarning {
  variantId: string;
  title: string;
  problems: LineProblem[];
  available: number | null;
}

export interface Cart {
  /** null when the shopper has no cart yet */
  token: string | null;
  currency: string;
  items: PricedLineDto[];
  unavailableItems?: Array<{ variantId: string; title: string }>;
  itemCount: number;
  subtotal: Money;
  discount: Money;
  tax: Money;
  taxInclusive: boolean;
  taxBreakdown: TaxBreakdownLine[];
  total: Money;
  shippingExcluded: boolean;
  couponCode: string | null;
  couponError: { reason: string; message: string } | null;
  warnings: CartWarning[];
}

// ───────────────────────── checkout ─────────────────────────

export interface ShippingAddressInput {
  fullName: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  /** ISO-3166 alpha-2 */
  country: string;
}

export interface ShippingMethod {
  code: string;
  name: string;
  type: "FLAT" | "FREE_OVER" | "PROVIDER_RATE" | (string & {});
  price: Money;
  freeOverAmount: Money | null;
  minDays: number | null;
  maxDays: number | null;
  countries: string[];
  /** present when a `subtotal` was passed */
  cost?: Money;
}

export interface CheckoutSummaryInput {
  shippingAddress: ShippingAddressInput;
  billingAddress?: ShippingAddressInput;
  shippingMethodCode?: string;
  couponCode?: string;
}

export interface CheckoutSummary {
  currency: string;
  subtotal: Money;
  discount: Money;
  shipping: Money;
  tax: Money;
  taxInclusive: boolean;
  taxBreakdown: TaxBreakdownLine[];
  total: Money;
  coupon: { code: string; discount: Money } | null;
  shippingMethod: { code: string; name: string; price: Money } | null;
  lines: PricedLineDto[];
}

export interface CheckoutCreateInput extends CheckoutSummaryInput {
  /** required for guests; defaults to the signed-in customer's email */
  email?: string;
  phone?: string;
  /** `MANUAL` (cash on delivery) or the store's active online provider; omit for the default */
  paymentProvider?: string;
}

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "PACKED"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED"
  | "RETURN_REQUESTED"
  | "RETURNED"
  | "REFUNDED";

export type PaymentStatus =
  "PENDING" | "AUTHORIZED" | "PAID" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED";

export interface OrderItem {
  productId: string;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string;
  imageUrl: string | null;
  attributes: unknown;
  unitPrice: Money;
  quantity: number;
  discount: Money;
  taxRate: string;
  taxAmount: Money;
  lineTotal: Money;
}

export interface Order {
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  currency: string;
  email: string;
  subtotal: Money;
  discount: Money;
  shipping: Money;
  tax: Money;
  taxBreakdown: unknown;
  total: Money;
  couponCode: string | null;
  shippingMethod: string | null;
  shippingAddress: ShippingAddressInput | null;
  billingAddress: ShippingAddressInput | null;
  paymentProvider: string | null;
  placedAt: string | null;
  cancelledAt: string | null;
  items: OrderItem[];
  timeline: Array<{ type: string; toStatus: string | null; message: string | null; at: string }>;
  payments: Array<{ provider: string; status: string; amount: Money }>;
}

/**
 * Provider-specific payload for completing payment in the browser.
 *  - RAZORPAY: `{ keyId, providerOrderId, amount (integer MINOR units), currency, name? }` -> open Razorpay Checkout
 *  - MOCK (non-production only): `{ mock: true, providerOrderId, amount (decimal string), currency }`
 *  - MANUAL: `{ manual: true }` (cash on delivery – nothing to do)
 */
export type ClientPayload = Record<string, unknown> & {
  keyId?: string;
  providerOrderId?: string;
  amount?: string | number;
  currency?: string;
  mock?: boolean;
  manual?: boolean;
};

export interface CheckoutResult {
  order: Order;
  paymentRequired: boolean;
  paymentProvider: string | null;
  providerAvailable: boolean;
  clientPayload: ClientPayload | null;
  paymentError?: string;
  /** true when this response replays an earlier call with the same Idempotency-Key */
  idempotentReplay?: boolean;
}

export interface PaymentVerifyInput {
  orderNumber: string;
  email?: string;
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface PaymentRetryInput {
  orderNumber: string;
  email: string;
}

/**
 * Responses of the payments endpoints. The contract lists the request bodies only; the SDK passes
 * the JSON response through. Expect at least `order` and/or `clientPayload` / `verified`.
 */
export interface PaymentVerifyResult {
  verified?: boolean;
  order?: Order;
  [k: string]: unknown;
}
export interface PaymentRetryResult {
  order?: Order;
  paymentRequired?: boolean;
  paymentProvider?: string | null;
  clientPayload?: ClientPayload | null;
  [k: string]: unknown;
}

// ───────────────────────── tracking / returns ─────────────────────────

export interface OrderTracking {
  [k: string]: unknown;
}

export interface ReturnCreateInput {
  orderNumber: string;
  email: string;
  reason: string;
  details?: string;
  items: Array<{ orderItemId: string; quantity: number }>;
}

export interface ReturnRequest {
  id: string;
  status?: string;
  [k: string]: unknown;
}

// ───────────────────────── customers ─────────────────────────

export interface Customer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthSession {
  customer: Customer;
  csrfToken: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface ProfileInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

export interface Address {
  id: string;
  customerId: string;
  label: string | null;
  fullName: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
  createdAt: string;
}

export interface AddressInput extends ShippingAddressInput {
  label?: string | null;
  isDefaultShipping?: boolean;
  isDefaultBilling?: boolean;
}

// ───────────────────────── reviews / blog / seo ─────────────────────────

export interface Review {
  id: string;
  authorName: string;
  rating: number;
  title: string | null;
  body: string;
  verifiedPurchase: boolean;
  createdAt: string;
}

export interface RatingAggregate {
  average: number;
  count: number;
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
}

export interface ReviewList extends Paginated<Review> {
  aggregate: RatingAggregate;
}

export interface ReviewQuery {
  page?: number;
  pageSize?: number;
  sort?: "newest" | "oldest" | "highest" | "lowest";
}

export interface ReviewInput {
  rating: number;
  title?: string;
  body: string;
  authorName: string;
  email: string;
}

export interface ReviewSubmitResult {
  id: string;
  /** new reviews are `PENDING` until a moderator approves them */
  status: "PENDING" | "APPROVED" | "REJECTED";
  rating: number;
  verifiedPurchase: boolean;
  message: string;
}

export interface BlogQuery {
  page?: number;
  pageSize?: number;
  tag?: string;
}

export interface BlogPostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  authorName: string | null;
  tags: string[];
  coverUrl: string | null;
  publishedAt: string;
}

export interface BlogPost extends BlogPostSummary {
  body: string;
  updatedAt: string;
  seo: (ProductSeo & { ogImageUrl?: string | null }) | null;
}

export interface SeoDefaults {
  titleTemplate: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultOgImageMediaId: string | null;
  defaultOgImageUrl: string | null;
  robots: "index" | "noindex";
  siteUrl: string | null;
}

export interface RobotsInfo {
  allow: boolean;
  disallow: string[];
  sitemapPath: string;
  siteUrl: string | null;
}

export interface SitemapEntry {
  slug: string;
  updatedAt: string;
}
export interface Sitemap {
  products: SitemapEntry[];
  categories: SitemapEntry[];
  collections: SitemapEntry[];
  pages: SitemapEntry[];
  blog: SitemapEntry[];
}

export interface ResolvedSeo {
  title: string;
  description: string;
  canonicalUrl: string | null;
  ogImageMediaId: string | null;
  ogImageUrl: string | null;
  noindex: boolean;
  nofollow: boolean;
  robots: string;
}

export type JsonLdType = "product" | "blogposting" | "organization" | "category";
/** schema.org JSON-LD document */
export type JsonLd = Record<string, unknown> & { "@context": string; "@type": string };
