# Database

PostgreSQL 14+ (16 recommended), managed with Prisma migrations in `packages/database/prisma/migrations`.
**Single store per database** - there is no `tenantId` anywhere.

## Principles

- Money is `Decimal(12,2)`; code does arithmetic in integer minor units. Never floats.
- Orders are **immutable snapshots**: item title/SKU/price/tax, customer, and both addresses are copied onto the order;
  later product edits never change history.
- Strongly relational commerce data is relational. JSON is used only where flexibility pays: CMS section `content`, product
  `properties`, provider/integration `config`, store settings groups, SEO blocks, invoice snapshot, tax breakdown.
- Foreign keys use `Restrict` for history-bearing references (order items, payments, media in use) and `Cascade` only for
  owned children (variants of a product, cart items).
- Database `CHECK` constraints back up invariants (migration `*_integrity_checks`): stock never negative (unless backorder),
  reserved >= 0, review rating 1..5, positive quantities, non-negative prices/totals, at most one default variant per product.

## Model groups

| Group        | Models                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth / RBAC  | `AdminUser`, `Role`, `Permission`, `RolePermission`, `AdminSession`, `AdminPasswordReset`, `AuditLog`                                                         |
| Store config | `StoreSettings` (singleton `id="store"`), `IntegrationSetting` (non-secret), `NotificationTemplate/Log`                                                       |
| Catalog      | `Category` (tree), `Collection`, `Product`, `ProductVariant`, `Attribute`, `AttributeValue`, `Tag`, `TaxClass`, `ProductImage`, `Media`                       |
| Inventory    | `InventoryItem` (onHand, reserved), `InventoryMovement` (append-only ledger)                                                                                  |
| Customers    | `Customer`, `CustomerSession`, `CustomerPasswordReset`, `Address`                                                                                             |
| Cart/Promo   | `Cart`, `CartItem`, `Coupon` (+ product/category targets), `CouponRedemption`, `ShippingMethod`                                                               |
| Orders       | `Order`, `OrderItem`, `OrderEvent`, `OrderNote`, `OrderSequence`, `Payment`, `Refund`, `Shipment`, `Invoice`, `InvoiceSequence`, `ReturnRequest/Item/History` |
| Safety       | `WebhookEvent` (unique `(provider,eventId)`), `IdempotencyKey`                                                                                                |
| Content      | `Page`, `PageSection`, `NavigationMenu/Item`, `FilterGroup`, `Review`, `BlogPost`                                                                             |

Inventory: `available = onHand - reserved`. Checkout **reserves**, confirmation **commits** (decrements both), cancel before
commit **releases**, cancel/return after commit **restocks**. All changes are single guarded SQL statements and write a
movement row.

## Operations

```bash
npm run db:validate       # prisma validate
npm run db:generate       # generate client
npm run db:migrate        # apply migrations (prod-safe, forward-only)
npm run db:migrate:dev    # create a new migration from schema changes (development only)
npm run db:studio         # browse data
```

Rules for new migrations: additive and backward compatible where possible; never edit an applied migration; test on an
empty database (`npm test` does this every run).

## Indexing

Indexes exist for every foreign key used in lookups plus the hot paths: `Product(status, publishAt)`, `Product(categoryId, status)`,
`Order(status, createdAt)`, `Order(email)`, `Review(productId, status, createdAt)`, `InventoryMovement(itemId, createdAt)`,
`AuditLog(entityType, entityId)`.

## Backup

See `docs/BACKUP_RESTORE.md`.
