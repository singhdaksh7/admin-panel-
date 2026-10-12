# Deployment

**One deployment = one client.** Each client gets its own Postgres, API, Admin and secrets. Repeat these steps per client.

## Topology

```
Internet -> TLS reverse proxy (Caddy / Traefik / Cloudflare Tunnel)
              -> admin (nginx: static SPA, proxies /api/* to api)   [port 8080]
                   -> api (Node, port 4000, internal)
                        -> postgres (internal)  + uploads volume or S3/R2
Custom storefront (anywhere) -> https://<admin-origin or api origin>/api/v1/...  via the Storefront SDK
```

The `admin` container serves the SPA **and** proxies `/api/*`, so the Admin and API share one origin: cookies are
`SameSite=Lax`, CSRF works, and no CORS is needed for the Admin.

## Steps (Docker Compose)

1. Provision a Linux host with Docker.
2. `git clone https://github.com/singhdaksh7/admin-panel-.git && cd admin-panel-`
3. Generate configuration: `npm install && npm run create-store` (writes `.env` + `store.config.json`),
   **or** copy `.env.example` and edit by hand. Rename the file to `.env.production`.
4. Edit `.env.production` - required for production:
   - `PUBLIC_API_URL` - the public https URL of the API (used in media URLs and webhooks)
   - `CORS_ORIGINS` - the storefront origin(s) (+ admin origin if it is served from a different host)
   - `POSTGRES_PASSWORD`, `SESSION_SECRET` (random, >= 32 chars), `COOKIE_SECURE=true`
   - provider secrets (Razorpay / Shiprocket / SMTP / S3) as needed - **env only, never committed**
5. `cp docker-compose.prod.yml.example docker-compose.prod.yml`
6. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
   - the API container applies pending migrations on start (`SKIP_MIGRATIONS=true` to opt out)
7. Create the first admin (the CLI is bundled in the API image; the password is passed at run time, never stored):
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production exec \
     -e INITIAL_ADMIN_EMAIL=you@example.com -e INITIAL_ADMIN_PASSWORD='a-strong-password' \
     api node apps/api/dist/cli/create-admin.js
   ```
   It is idempotent (an existing admin is left unchanged) and enforces the password policy. Change the password
   after first sign-in under **My account**.
8. Put a TLS reverse proxy in front of the `admin` service (port 8080).
9. Smoke test: `GET https://<host>/api/health` -> `ok`, `GET /api/ready` -> `database: ok`, sign in to the Admin.

## Health and observability

- `GET /api/health` - process liveness. `GET /api/ready` - verifies the database (503 when unreachable).
- Docker `HEALTHCHECK` is built into the API image.
- Logs are structured JSON (pino) with a `requestId` on every line; `X-Request-Id` is echoed to clients and
  included in every error body so support can find the exact log lines. Secrets/cookies/passwords are redacted.

## Upgrades

`git pull` -> `docker compose ... up -d --build`. Migrations are forward-only and applied automatically.
**Back up first** (`docs/BACKUP_RESTORE.md`).

## Storage

- `LOCAL`: uploads live in the `uploads` volume, served by the API at `/api/v1/media/files/<key>`. Back the volume up.
- `S3`: set `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, and for R2/MinIO `S3_ENDPOINT`;
  `S3_PUBLIC_BASE_URL` is the public/CDN base URL for objects.

## Hardening checklist

See `docs/SECURITY.md`. At minimum: strong secrets, HTTPS only, `CORS_ORIGINS` limited to real origins, database not
exposed publicly, regular verified backups, and remove `PAYMENT_PROVIDER=MOCK`.
