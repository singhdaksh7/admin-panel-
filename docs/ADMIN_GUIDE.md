# Admin guide

The Admin is a responsive web app (served at the root of the `admin` container; `npm run dev:admin` locally). What you can see
and do depends on your **role**; anything you lack permission for is hidden, and the server enforces it too.

## Roles (default)

| Role              | Intended for                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| SUPER_ADMIN       | Everything, including roles. At least one active Super Admin always exists                           |
| ADMIN             | Everything except defining roles                                                                     |
| CATALOG_MANAGER   | Products, categories, collections, attributes, inventory, media, filters                             |
| ORDER_MANAGER     | Orders, returns, customers, refunds, shipments                                                       |
| CONTENT_MANAGER   | Pages, navigation, blog, media, SEO, review moderation                                               |
| SUPPORT           | Read-only across the store, plus review moderation                                                   |

Create custom roles under **System -> Roles** (permission matrix). Changing a role signs its users out.

## Daily work

**Dashboard** - paid revenue (today / 7 / 30 days), orders by status (click to filter), low stock, top products, recent
orders and alerts (unpaid orders older than 30 minutes, out-of-stock variants).

### Catalog
- **Categories** - tree with unlimited nesting; image/banner, SEO, active flag, ordering. A category with products or children
  cannot be deleted unless you reassign its contents.
- **Attributes** - define Color, Size, Author, Format... (any name). Mark as *used for variants* and/or *filterable*.
- **Products** - the main form: basics, scheduling (publish/unpublish at a date), category/tags/collections, images (first is the
  main one), attributes, price/compare-at/cost/SKU/stock for simple products, **variants** for multi-option products (each
  variant has its own SKU, price, stock, image, weight/dimensions, and can be disabled), SEO. Status **Draft** is invisible to
  the storefront; **Active** (and inside its schedule window) is live. Delete archives products that have orders.
- **Collections** - manual lists, or rule-based (category/tag/price/attribute).
- **Inventory** - adjust stock with a mandatory reason (delta or set), low-stock threshold, track/backorder flags, full movement
  history. Stock a customer's checkout has reserved shows as *reserved* until the order is confirmed.

### Orders
- **Orders** - filter by status/payment/date, search by number/email/name. The order page shows immutable snapshots of what
  was bought, totals and tax, addresses, payments, shipments, a timeline and internal notes.
- Only valid next statuses are offered: Pending -> Confirmed -> Processing -> Packed -> Shipped -> Delivered; cancel is possible
  until shipped. **COD** orders: use *Mark paid* once cash is collected. **Create shipment** (Packed orders), **Refund**,
  **Invoice** (PDF).
- **Returns** - customers request returns for delivered orders (within the return window); you approve/reject, receive items
  (choose which go back into stock) and refund.
- **Customers** - profiles, order history; deactivate an account if needed.

### Marketing
- **Coupons** - fixed or percentage, minimum order, maximum discount, date range, total and per-customer usage caps, limited to
  products/categories.
- **Reviews** - new reviews arrive as *Pending*; approve or reject (optionally with a note). Only approved reviews are public.

### Content (the storefront decides how it looks)
- **Pages** - e.g. slug `home`. Add **sections** (Hero, Promo banner, Text, Image, Product grid, Category grid, Rich text, Reviews,
  Blog preview, Custom JSON), reorder, enable/disable, schedule. Your developer renders each section type.
- **Navigation** - header/footer menus with nesting, category/collection/page links, mega-menu promo cards, badges and
  desktop/mobile visibility. "Auto children" on a category link lists its sub-categories automatically.
- **Blog** - drafts, scheduled publishing, cover image, tags, SEO. **Media** - upload, alt text; images in use cannot be deleted.

### Storefront
- **Filters** - choose which filter groups appear per category (or globally): categories, collections, price, stock, attributes,
  tags, properties; label, order, open/closed, single/multi select, desktop/mobile, inherited by sub-categories. Counts are
  computed from real catalog data.
- **SEO** - store-wide title template, default description, default share image, noindex switch.
- **Store Settings** - identity (name, logo, contact), currency/locale/timezone, tax mode (none / exclusive / inclusive / India GST
  with GSTIN), checkout rules (guest checkout, minimum order, order & invoice prefixes, return window), feature flags
  (accounts, reviews, blog, coupons, inventory) and social links.

### System
- **Admin Users** - create with a temporary password (they must change it), change role, deactivate (kills their sessions).
- **Audit Logs** - who changed what and when, with a safe before/after summary and request id. Passwords/secrets never appear.
- **Integrations** - shows the active payment/shipping/email/storage providers, whether each required secret is configured
  (yes/no only), and non-secret options. **Secrets are set in the server environment, never in the Admin.**

## Tips
- Use **My account** (user menu) to change your password. Sessions refresh automatically; after 8 idle hours you sign in again.
- Money is shown in the store currency; change currency before you have orders - existing orders keep their own currency.
- To hide a product temporarily set it to Draft; to retire one, Archive.
