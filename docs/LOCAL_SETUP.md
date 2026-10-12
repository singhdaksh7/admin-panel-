# Local setup

Requirements: **Node 20+** (22 recommended), **npm 10+**, **Docker** (for Postgres). Nothing else.

```bash
git clone https://github.com/singhdaksh7/admin-panel-.git
cd admin-panel-
npm install
cp .env.example .env            # local defaults already work; see "Environment" below
npm run dev:db                  # Postgres 16 on localhost:55440 (docker compose)
npm run db:generate             # generate the Prisma client
npm run db:migrate              # apply ALL migrations to the empty database
```

Create the first admin (the password is supplied at run time and never stored in a file):

```bash
INITIAL_ADMIN_EMAIL=admin@example.com INITIAL_ADMIN_PASSWORD='choose-a-strong-password' npm run create-admin
```

Run the API and the Admin:

```bash
npm run dev:api                 # http://localhost:4000   (health: /api/health, readiness: /api/ready)
npm run dev:admin               # http://localhost:5174   (proxies /api to :4000)
```

Open http://localhost:5174 and sign in. Then: **Catalog -> Categories**, **Catalog -> Products**, publish a product.

## Environment

All configuration is environment variables, validated at startup with readable errors (see `.env.example`).
`npm run` scripts load `.env` automatically. Key variables:

| Variable                                 | Purpose                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                           | Postgres connection string                                               |
| `SESSION_SECRET`                         | >= 32 chars; signs verification tokens. Generate: `openssl rand -hex 32` |
| `CORS_ORIGINS`                           | Comma-separated browser origins (admin + storefront). No wildcards       |
| `PAYMENT_PROVIDER` / `SHIPPING_PROVIDER` | `MOCK`/`MANUAL`/`RAZORPAY` and `MANUAL`/`MOCK`/`SHIPROCKET`              |
| `STORAGE_PROVIDER`                       | `LOCAL` (uploads dir) or `S3` (AWS S3 / Cloudflare R2 / compatible)      |

`PAYMENT_PROVIDER=MOCK` is rejected when `NODE_ENV=production`.

## Tests and checks

```bash
npm run lint
npm run typecheck
npm test                 # API (Postgres required, uses an isolated *_test database), Admin, SDK
npm run test:scripts     # create-store generators
npm run build
```

API tests create their own database (`commerce_test`, override with `TEST_DB_NAME`) on the same Postgres server and
apply every migration from scratch, so a green run also proves migrations work on an empty database.

## Troubleshooting

- **`Invalid environment configuration`** - the message lists exactly which variables are wrong.
- **`Cannot connect to the database`** - is `npm run dev:db` running? Is `DATABASE_URL` using port 55440?
- **Admin shows login loop** - API and Admin must be same-site. In dev the Vite proxy handles this; do not call
  the API from another host/port directly with cookies.
- **Port 55440 in use** - change the port mapping in `docker-compose.yml` and `DATABASE_URL`.
