# Architecture

Kash Commerce is a **single-store** commerce backend + admin. **One deployment = one client.** There is no
tenant id anywhere in the schema; each client gets its own Postgres database, API, Admin, storage and provider
configuration. The same codebase is cloned/deployed repeatedly.

```
CUSTOM STOREFRONT  ->  STOREFRONT SDK  ->  COMMERCE API  ->  POSTGRES / STORAGE / PROVIDERS
                                               ^
                                          ADMIN PANEL
```

## Package boundaries

| Package                    | Responsibility                                                                               | May import        |
| -------------------------- | -------------------------------------------------------------------------------------------- | ----------------- |
| `packages/shared`          | Errors, money math (integer minor units), pagination, permissions catalog                    | nothing           |
| `packages/config`          | Env validation (zod). Fails fast with readable messages                                      | nothing           |
| `packages/contracts`       | Zod schemas / TS types for the public + admin API                                            | shared            |
| `packages/provider-sdk`    | Interfaces: `PaymentProvider`, `ShippingProvider`, `NotificationProvider`, `StorageProvider` | nothing           |
| `packages/database`        | Prisma schema, migrations, client                                                            | nothing           |
| `packages/storefront-sdk`  | Browser/server client for the public API. **No internal imports** (publishable)              | nothing           |
| `apps/api`                 | Express API, modules, providers                                                              | all but admin/sdk |
| `apps/admin`               | React admin SPA; talks to the API over HTTP only                                             | shared, contracts |
| `examples/demo-storefront` | Proof frontend; consumes **only** the SDK                                                    | storefront-sdk    |

## Request flow

```
request -> requestId -> pino-http -> helmet -> CORS allowlist -> json(1mb, raw body kept) -> cookies
  /api/health, /api/ready
  /api/v1/webhooks/*   -> webhook limiter -> provider signature check -> idempotent (provider,eventId)
  /api/v1/admin/auth/* -> auth limiter    -> login/refresh/reset (no session required)
  /api/v1/admin/*      -> admin limiter -> session cookie -> CSRF header -> requirePermission(...) -> handler -> audit()
  /api/v1/*            -> public limiter(s) -> handler            (storefront API)
-> notFound -> errorHandler  ({ error: { code, message, details?, requestId } })
```

## Auth model

- **Admin**: opaque random session token in an `httpOnly`, `SameSite=Lax`, path-scoped cookie; only its SHA-256
  is stored. `POST /admin/auth/refresh` **rotates** the token; presenting an already-rotated token revokes the whole
  session family (theft detection). Every unsafe request needs the per-session `X-CSRF-Token` (returned at
  login/refresh). Passwords: Argon2id. Lockout with exponential backoff after 5 failures. Admin and API must be
  same-site (sub-domains of one registrable domain, or one origin behind a reverse proxy).
- **RBAC**: `Permission` keys (`products.write`…) → `Role` (6 system roles + custom) → `AdminUser`. Roles are
  enforced per route with `requirePermission`. Last active SUPER_ADMIN cannot be removed.
- **Customers**: same session design on a separate cookie, optional (guest checkout supported).
- **Audit**: sensitive admin mutations call `audit()`; secrets/tokens/password keys are scrubbed.

## Modules

Feature modules live in `apps/api/src/modules/<name>/index.ts` and export `register(ctx) => { public?, admin?,
adminPublic?, webhooks? }`. They are listed in `modules/registry.ts`. Modules receive an `AppContext`
(`env`, `prisma`, `logger`, `providers`) – nothing is global, so tests build isolated contexts.

## Provider system

Interfaces live in `packages/provider-sdk`; implementations are registered in `apps/api/src/providers/build.ts`.
Active payment/shipping provider is chosen by env (`PAYMENT_PROVIDER`, `SHIPPING_PROVIDER`). **Secrets are env
only**; the DB (`IntegrationSetting`) stores non-secret options. Adding Stripe/Cashfree/PayPal = implement one
interface + register it (see `docs/EXTENDING_PROVIDERS.md`).

## Database ownership

The API is the only writer. Money is `Decimal(12,2)`; orders carry immutable snapshots (items, addresses,
customer, tax). JSON is used only for CMS payloads, provider metadata and structured settings. DB `CHECK`
constraints back up critical invariants (non-negative stock, rating range). See `docs/DATABASE.md`.

## Storefront integration

Public API under `/api/v1/...` (versioned, additive changes only within v1) is wrapped by
`@kash-commerce/storefront-sdk`. A storefront needs only `VITE_COMMERCE_API_URL`. See
`docs/STOREFRONT_INTEGRATION.md`.

## Deployment model

Per client: Postgres + API container + static Admin behind a reverse proxy (one origin). Config via env. See
`docs/DEPLOYMENT.md` and `docs/NEW_CLIENT_CHECKLIST.md`.

## Extension strategy

New feature = new module folder + registry line + (if needed) additive migration. New provider = implement the SDK
interface. New section type for CMS = add a zod content schema in the content module's type map.
