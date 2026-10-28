# Kash Commerce

A **reusable, single-store ecommerce backend and administration platform**, designed to power independent, fully custom
storefronts.

**This is not a SaaS.** One deployment per client/store: every client gets its own Postgres database, API, Admin, storage,
payment and shipping configuration. You clone the repo, configure it, deploy it, and connect a custom frontend through the
Storefront SDK. You should not have to touch backend code for a normal new client.

```
CUSTOM STOREFRONT
       ↓
STOREFRONT SDK
       ↓
COMMERCE API
       ↓
POSTGRES / STORAGE / PROVIDERS
       ↑
ADMIN PANEL
```

## What is included

| Area               | Capabilities                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Catalog            | Products, variants, dynamic attributes, categories (tree), collections (manual/rule), tags, media library, SEO, scheduling |
| Inventory          | Reserve -> commit -> release/restock ledger, low-stock alerts, no overselling under concurrency                            |
| Orders             | Guest + account checkout, idempotent, immutable snapshots, canonical event timeline, notes, professional A4 invoices (PDF) |
| Customer Auth      | Passwordless / email OTP login, password login, rate-limited attempts, automated guest order claiming upon mailbox ownership |
| Notifications      | SMTP platform, responsive HTML templates, allowlisted variables, failure isolation, delivery audit logs, internal alerts   |
| Money              | Decimal everywhere, coupons, generic tax engine (none / exclusive / inclusive / India GST)                                 |
| Payments           | Cashfree PG (v2023-08-01), Razorpay, Manual/COD, Mock; signature-verified, replay-safe webhooks, refunds                   |
| Shipping           | Shiprocket, Manual, Mock; shipments, tracking, graceful provider failure, courier event mapping                             |
| Returns            | Request -> approve/reject -> receive -> refund, with per-item restock                                                      |
| Content (headless) | Pages + typed sections, navigation + mega menus, faceted filters with real counts, reviews, blog, SEO/sitemap              |
| Security           | Argon2id, SHA-256 hashed OTPs, rotating sessions + reuse detection, CSRF, RBAC with audit log, separate rate-limit classes  |
| Ops                | Docker, health/readiness, structured logs, backup + verified restore, CI                                                   |

## Repository layout

```
apps/api                  Express + Prisma API (public storefront API, admin API, webhooks)
apps/admin                React admin panel (catalog, orders, customers, templates, alerts, logs)
packages/database         Prisma schema + migrations
packages/storefront-sdk   @kash-commerce/storefront-sdk - the only thing a storefront needs
packages/provider-sdk     Payment / shipping / notification / storage interfaces
packages/{shared,config,contracts}   Money, errors, permissions, env validation
examples/demo-storefront  A deliberately simple storefront that uses ONLY the SDK
scripts/                  create-store CLI, backup, restore
docs/                     Architecture, setup, deployment, security, integration guides
```

## Quick start

```bash
git clone https://github.com/singhdaksh7/admin-panel-.git && cd admin-panel-
npm install
cp .env.example .env
npm run dev:db && npm run db:generate && npm run db:migrate
INITIAL_ADMIN_EMAIL=admin@example.com INITIAL_ADMIN_PASSWORD='choose-a-strong-one' npm run create-admin
npm run dev:api        # http://localhost:4000
npm run dev:admin      # http://localhost:5174
```

Details: [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

## Launching a new client

```bash
npm run create-store          # interactive: name, currency, providers, features -> .env + store.config.json
```

then follow [docs/NEW_CLIENT_CHECKLIST.md](docs/NEW_CLIENT_CHECKLIST.md). On the frontend the only configuration is

```
VITE_COMMERCE_API_URL=https://api.client.com
```

```ts
import { createCommerceClient } from "@kash-commerce/storefront-sdk";
const commerce = createCommerceClient({ baseUrl: import.meta.env.VITE_COMMERCE_API_URL });
const { items } = await commerce.products.list({ category: "shoes", sort: "price_asc" });
```

Integration guide (30-60 minutes): [docs/STOREFRONT_INTEGRATION.md](docs/STOREFRONT_INTEGRATION.md).

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Local setup](docs/LOCAL_SETUP.md) · [Deployment](docs/DEPLOYMENT.md) ·
[Database](docs/DATABASE.md) · [Admin guide](docs/ADMIN_GUIDE.md) · [Storefront integration](docs/STOREFRONT_INTEGRATION.md) ·
[Payments](docs/PAYMENTS.md) · [Shipping](docs/SHIPPING.md) · [Transactional Email](docs/EMAIL.md) ·
[Customer Auth](docs/CUSTOMER_AUTH.md) · [Production Readiness](docs/PRODUCTION_READINESS.md) ·
[Backup & restore](docs/BACKUP_RESTORE.md) · [Security](docs/SECURITY.md) · [New client checklist](docs/NEW_CLIENT_CHECKLIST.md) ·
[Extending providers](docs/EXTENDING_PROVIDERS.md)

## Quality gates

`npm run lint` · `npm run typecheck` · `npm test` (API integration tests against a real Postgres built from migrations,
Admin, SDK, demo) · `npm run test:scripts` · `npm run build`. CI runs all of them without any production secrets.

## Production Baseline

Kash Commerce has been hardened using operational architectural patterns proven in real-world production ecommerce deployments:
- Single-store isolation (one client = one independent deployment)
- Generic, domain-agnostic schemas without hardcoded merchant assumptions
- Cryptographic verification of all provider webhooks and customer mailbox ownership
- Failure isolation: external mail, gateway, and carrier failures never block order placement or data consistency

## License

Proprietary - all rights reserved by the repository owner unless a LICENSE file says otherwise.
