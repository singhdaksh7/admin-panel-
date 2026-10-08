# Kash Commerce

A **reusable, single-store ecommerce backend and administration platform** designed to power independent,
fully custom storefronts.

**Not a SaaS. One deployment per client/store.** Every client gets its own Postgres database, API, Admin,
storage, payment and shipping configuration. Clone, configure, deploy, connect a custom frontend.

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

Status: under active construction - see `docs/` as phases land.

## Quick start (development)

```bash
npm install
cp .env.example .env            # then edit values
npm run dev:db                  # Postgres on :55440
npm run db:generate && npm run db:migrate
INITIAL_ADMIN_PASSWORD='choose-a-strong-one' npm run create-admin
npm run dev:api
```

See `docs/ARCHITECTURE.md`.
