# Transactional Email & Notifications Platform

Kash Commerce incorporates a reliable, brand-agnostic transactional email system designed for high deliverability, auditability, and failure isolation.

Transactional communications are completely isolated from marketing/promotional lists and cannot be broken by customer marketing opt-outs.

---

## 1. Architecture

```
[Commerce Events] (Checkout, Status Transition, Return, Auth)
        │
        ▼
[Central notify() / notifyAdmin()]
        │
        ├── Check Template Enabled / Cooldown / Deduplication
        │
        ├── Render Subject & Body with Allowlisted Variables
        │
        ├── Generate Responsive Email HTML (or Custom Template)
        │
        ├── Dispatch to Active Provider (SMTP / Log)
        │
        └── Write NotificationLog (Status, Attempt Time, Payload, Error)
```

- **Failure Isolation**: An email provider timeout or outage will **never** roll back a legitimate order, payment, shipment, or refund. All notification dispatches are wrapped in failure-isolated boundaries.
- **Delivery Log**: Every attempt is recorded in `NotificationLog` with status (`SENT`, `FAILED`, `SKIPPED`), retry counts, error message, and payload snapshot.
- **Retries**: Bounded automated retry capability and manual one-click retry from the Admin Panel.

---

## 2. Standard Event Catalog

| Event Key | Trigger | Recipient |
| :--- | :--- | :--- |
| `customer.welcome` | Customer account created | Customer |
| `customer.login_code` | Passwordless OTP login requested | Customer |
| `password.reset` | Password reset requested | Customer |
| `order.confirmation` | Order confirmed (paid or COD approved) | Customer |
| `order.processing` | Order moved to processing/packed | Customer |
| `order.shipped` | Shipment created with tracking / AWB | Customer |
| `order.in_transit` | Carrier scan milestone | Customer |
| `order.out_for_delivery` | Package out for delivery | Customer |
| `order.delivered` | Successful delivery confirmed | Customer |
| `order.delivery_failed` | Delivery attempt failed | Customer |
| `order.cancelled` | Order cancelled by admin or customer | Customer |
| `refund.initiated` | Refund process initiated | Customer |
| `refund.completed` | Refund successfully settled | Customer |
| `admin.new_order` | High-value new order placed | Internal Admin List |
| `admin.payment_failed` | Payment attempt failed | Internal Admin List |
| `admin.return_requested` | Customer requested a return | Internal Admin List |

---

## 3. Template Variables (Allowlisted)

Templates support Handlebars-lite `{{variable}}` substitution. To prevent arbitrary code execution, all variables are strictly allowlisted:

| Variable | Description |
| :--- | :--- |
| `{{storeName}}` | Current public store name |
| `{{supportEmail}}` | Store customer support email address |
| `{{accountUrl}}` | Storefront customer account portal URL |
| `{{name}}` / `{{customerName}}` | Customer's full name or email prefix |
| `{{orderNumber}}` | Public order number (e.g., `KC-100234`) |
| `{{orderTotal}}` / `{{total}}` | Formatted order total |
| `{{currency}}` | ISO 4217 currency code (e.g., `INR`, `USD`) |
| `{{code}}` | 6-digit one-time passwordless login code (never logged) |
| `{{link}}` | Action link (e.g. password reset URL, email verify link) |
| `{{trackingNumber}}` | Carrier tracking number / AWB |
| `{{trackingUrl}}` | Direct tracking page URL |
| `{{courierName}}` | Carrier / courier name |
| `{{adminOrderUrl}}` | Direct link to Admin Panel order detail view |

---

## 4. SMTP Provider Configuration

Configure standard transactional SMTP credentials via environment variables:

```bash
EMAIL_PROVIDER=SMTP
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@yourdomain.com
SMTP_PASSWORD=your-smtp-secret-password
EMAIL_FROM="Kash Store <orders@yourdomain.com>"
```

For local development and automated testing, set:
```bash
EMAIL_PROVIDER=LOG
```
In `LOG` mode, emails are formatted, verified, logged to structured logging output and persisted to `NotificationLog` without attempting an outbound network socket connection.

---

## 5. Internal Admin Alerts

The Admin panel allows defining one or more internal operations email recipients (e.g., `ops@yourstore.com`, `finance@yourstore.com`).

Supported event toggles:
- New order placed (enabled by default)
- Payment failed
- Order cancelled
- Shipment dispatched
- Order delivered
- Return requested
- Refund completed

Alerts are automatically deduplicated per order, event, and recipient.
