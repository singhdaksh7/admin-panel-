# Production Readiness Guide & Operational Baseline

Kash Commerce has been designed and hardened using lessons from real-world production ecommerce deployments. This document details the baseline architecture, operational principles, security boundaries, and pre-launch verification checklist.

---

## 1. Single-Store Reusable Philosophy

Kash Commerce is intentionally **single-store, brand-agnostic, and domain-agnostic**:
- **Not a Multi-Tenant SaaS**: Every store or client receives an isolated Postgres database, backend API, admin instance, file storage, and credentials.
- **Provider-Extensible**: Payment gateways (Cashfree, Razorpay, Manual/COD), shipping carriers (Shiprocket, Manual), transactional emails (SMTP, Log), and storage engines (Local, S3) are abstracted behind strict SDK interfaces.
- **Zero Hardcoded Brand Identity**: Logo, branding, currency, tax rules (GST / inclusive / exclusive), shipping fees, and policies are completely dynamic and configured in store settings.

---

## 2. Core Hardened Domains

### A. Customer Authentication & Lifecycle
- **Passwordless OTP Login**: 6-digit cryptographic code, SHA-256 hashed at rest in `CustomerOtp`, 10-minute expiry, max 5 attempts, 60s resend cooldown.
- **Enumeration Protection**: Generic responses prevent revealing whether an email exists.
- **Guest Order Claiming**: Prior guest orders are securely claimed only after mailbox ownership is verified.
- **CSRF & Session Security**: Rotating refresh token family detection with strict CSRF header enforcement on state-modifying requests.

### B. Transactional Email System
- **Provider**: Standard SMTP transport with failure isolation. An email provider timeout will never roll back an order or payment.
- **Templates**: Allowlisted variable substitution (`{{storeName}}`, `{{orderNumber}}`, `{{trackingUrl}}`, etc.) prevents arbitrary code execution.
- **Audit Logs & Retries**: Every delivery attempt is logged in `NotificationLog` with status, retry counts, and payload. Failed deliveries support bounded and manual one-click retries.
- **Internal Admin Alerts**: Real-time alerts for high-value orders, payment failures, cancellations, and return requests sent to configured operational inboxes.

### C. Payment Engine
- **First-Class Providers**: Cashfree PG (v2023-08-01), Razorpay, Manual/COD, Mock.
- **Server-Side Verification**: Client responses are strictly informative; authorization relies on raw-body cryptographic HMAC signatures and upstream status queries.
- **Idempotency & Replay Safety**: Webhook deliveries are guarded by a unique `(provider, eventId)` ledger. Repeated webhook deliveries produce zero duplicate stock deductions, invoices, or emails.

### D. Inventory & Order Safety
- **Ledger Transitions**: Stock moves predictably through `RESERVE -> COMMIT -> RELEASE / RESTOCK`.
- **Concurrency Safety**: Double decrement on concurrent webhooks or race conditions is completely prevented.
- **Invoices**: Professional A4 PDF generation with multi-page repeating table headers, "Page X of Y" pagination, and conditional legal titles ("TAX INVOICE" displayed only when legal GSTIN is configured).

---

## 3. Pre-Launch Client Checklist

Before taking any client live:

- [ ] **Environment Secrets**: Verify `SESSION_SECRET` is generated randomly (>= 32 characters) and `COOKIE_SECURE=true`.
- [ ] **Database Migrations**: Run `npm run db:migrate` against the production Postgres instance.
- [ ] **Payment Provider**:
  - For Cashfree: Set `PAYMENT_PROVIDER=CASHFREE`, `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, and `CASHFREE_ENV=production`. Register the webhook URL in the Cashfree dashboard.
  - For Razorpay: Set `PAYMENT_PROVIDER=RAZORPAY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. Register the webhook URL.
- [ ] **Shipping Provider**:
  - For Shiprocket: Set `SHIPPING_PROVIDER=SHIPROCKET`, `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`. Set `pickupLocation` and `pickupPostcode` in Admin Integrations.
- [ ] **Transactional Email**:
  - Configure `EMAIL_PROVIDER=SMTP` with verified sender domain (`EMAIL_FROM`).
  - Configure operational alert recipients in Admin -> System -> Notifications -> Internal admin alerts.
- [ ] **Store Identity & Invoicing**:
  - Configure Store Name, Tagline, Support Email, Currency, and Locale.
  - If registered for GST/tax, enter legal name and GSTIN in Store Settings -> Tax.
- [ ] **Quality Gates Verification**:
  - Ensure all automated checks pass cleanly:
    - `npm run db:validate`
    - `npm run typecheck`
    - `npm run lint`
    - `npm test`
    - `npm run build`
