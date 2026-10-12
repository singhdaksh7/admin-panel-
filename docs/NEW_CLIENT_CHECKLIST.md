# New client checklist

Goal: launch a new client's store **without modifying backend code**. Work through this top to bottom.

| #   | Step                    | How                                                                                                                                               | Done |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Clone the reusable repo | `git clone https://github.com/singhdaksh7/admin-panel-.git client-name && cd client-name`                                                         | [ ]  |
| 2   | Configure env           | `npm install && npm run create-store` -> review `.env`; rename to `.env.production` on the server                                                 | [ ]  |
| 3   | Create the database     | Compose creates it from `POSTGRES_DB`; or create an empty Postgres DB and set `DATABASE_URL`                                                      | [ ]  |
| 4   | Migrate                 | `npm run db:migrate` (Docker: automatic on API start)                                                                                             | [ ]  |
| 5   | Create the first admin  | `INITIAL_ADMIN_PASSWORD='...' npm run create-admin` (Docker: see `docs/DEPLOYMENT.md` step 7)                                                     | [ ]  |
| 6   | Configure the store     | `npm run create-store -- --apply store.config.json`, then Admin -> **Store Settings** (logo, contact, tax, checkout)                              | [ ]  |
| 7   | Configure payment       | Set provider env vars (`docs/PAYMENTS.md`); Admin -> **Integrations**; test an order end to end                                                   | [ ]  |
| 8   | Configure shipping      | Admin -> **Store Settings / shipping methods**, provider env vars (`docs/SHIPPING.md`)                                                            | [ ]  |
| 9   | Deploy API + Admin      | `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` behind TLS (`docs/DEPLOYMENT.md`)                            | [ ]  |
| 10  | Connect the storefront  | `VITE_COMMERCE_API_URL=https://<api-origin>` + the Storefront SDK (`docs/STOREFRONT_INTEGRATION.md`); add the storefront origin to `CORS_ORIGINS` | [ ]  |
| 11  | Add content             | Admin: categories, attributes, products (publish), navigation, home page sections, filters, blog, SEO                                             | [ ]  |
| 12  | Launch                  | Run the pre-launch checks below, switch DNS, watch `/api/ready` and the Admin dashboard                                                           | [ ]  |

## Pre-launch checks

- [ ] `PAYMENT_PROVIDER` is **not** `MOCK`; a real (or COD) test order completes and appears in Admin -> Orders
- [ ] Payment webhook URL registered with the provider: `https://<api>/api/v1/webhooks/razorpay`
- [ ] `COOKIE_SECURE=true`, strong `SESSION_SECRET`, `CORS_ORIGINS` lists only real origins
- [ ] `PUBLIC_API_URL` is the public https URL (media URLs and webhooks depend on it)
- [ ] Email provider set to SMTP; password-reset and order-confirmation emails received
- [ ] Backups scheduled **and** `scripts/restore/restore.sh <dump> --verify` passes (`docs/BACKUP_RESTORE.md`)
- [ ] Default admin password changed; extra admins created with least-privilege roles
- [ ] Inventory: stock quantities set (a product with no inventory row is treated as untracked/unlimited)
- [ ] Legal pages created under Content -> Pages; invoice details (GSTIN etc.) set in Store Settings if applicable

## What you should NOT need to do

Edit backend code, the Prisma schema, or the Admin app. If a client needs something genuinely new, add a module
(`docs/EXTENDING_PROVIDERS.md`, `docs/ARCHITECTURE.md` -> Extension strategy) and keep it generic for the next client.
