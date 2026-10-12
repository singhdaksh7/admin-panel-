# Security

## Authentication & sessions

- **Passwords**: Argon2id (19 MiB, t=2). Policy: >= 10 characters mixing lower-case with upper/digit/symbol.
- **Admin sessions**: opaque 256-bit token in an `httpOnly`, `SameSite=Lax`, `Secure` (prod), path-scoped cookie; only the
  SHA-256 is stored. Sessions are **rotated** on refresh. Re-using an already-rotated token revokes the **entire
  session family** (token-theft detection). Password change / reset / role change / deactivation revoke sessions.
- **CSRF**: every unsafe request must carry the per-session `X-CSRF-Token` (compared in constant time). Logout is CSRF-protected too.
- **Lockout**: 5 failed logins -> exponential backoff lock (max 30 min). Failed and unknown-user logins return the same
  message and take comparable time (no user enumeration).
- **Reset flows** are non-enumerating, single-use, 1-hour tokens; stored hashed.
- **Customers**: same session model on a separate cookie. Guest orders are attached to an account **only after the
  email address is verified** (signed token or completed password reset).

## Authorization

- Granular permissions (`products.write`, `orders.update`, ...) enforced **per route** server-side; the Admin UI hides
  controls but never relies on that. Six system roles + custom roles. The last active SUPER_ADMIN cannot be removed
  or deactivated; only a SUPER_ADMIN can create/modify SUPER_ADMINs.
- Customer and guest data endpoints are IDOR-safe: account routes use the session's customer id; guest order lookup
  requires order number **and** the matching email and returns a uniform 404 otherwise.

## Input, output and transport

- Zod validation on every body/query; unknown fields stripped (no mass assignment). Page sizes capped at 100.
  JSON body limit 1 MB; uploads limited by `MAX_UPLOAD_MB`.
- **Uploads**: type is decided by **magic bytes**, extension and declared MIME must agree; SVG is rejected; random storage
  keys; files served with `nosniff` and a locked-down CSP; deletion blocked while referenced.
- Rich text is sanitized with an allow-list on write (`sanitize-html`).
- Helmet headers; CORS is an exact-match **allow-list** (wildcards are refused at startup); production errors never leak stack traces.
- **Rate limits** are separate classes (public reads, auth, checkout/payment, admin, public writes, webhooks) so storefront
  browsing can never lock out login or checkout.

## Money & orders

- Prices are always read from the database server-side; client-supplied prices are ignored. Money is `Decimal(12,2)`
  and integer minor units in code - never floats.
- Stock is reserved with guarded atomic SQL inside the checkout transaction (no overselling under concurrency - covered by
  parallel tests). Orders snapshot items, prices, tax and addresses immutably. Checkout is idempotent (`Idempotency-Key`).
- **Payments**: the server verifies provider signatures itself (HMAC, constant time) and cross-checks the amount; the client
  is never trusted for payment status. **Webhooks** verify the signature over the raw body first and are de-duplicated by
  `(provider, eventId)` under a unique constraint, so replays are processed exactly once.

## Secrets

- **Environment only.** Provider secrets (Razorpay, Shiprocket, SMTP, S3) are never stored in the database, never returned by
  any API (the Integrations screen only shows configured yes/no), and never logged or audited (keys matching
  password/secret/token/key are scrubbed). `.env*` is git-ignored; only `.env.example` is committed.
- `PAYMENT_PROVIDER=MOCK` and an example `SESSION_SECRET` are rejected in production.

## Auditing

Sensitive admin mutations write an `AuditLog` row: actor, action, entity, safe before/after summary, request id, IP.

## Operational advice

HTTPS only; database on a private network; verified off-host backups; rotate provider keys on staff changes; keep
dependencies updated (`npm audit`); review the audit log. Report vulnerabilities privately to the repository owner.
