# Extending providers

Payment, shipping, notification and storage are **interfaces** in `packages/provider-sdk`. The API only talks to the
interface, so adding Stripe, Cashfree, PayPal, Delhivery, SMS or WhatsApp is: implement one interface, register it, set
an env var. No change to checkout, orders, Admin or the Storefront SDK.

## Payment provider (e.g. Stripe)

```ts
// apps/api/src/providers/payment/stripe.ts
import type { PaymentProvider } from "@kash-commerce/provider-sdk";

export class StripeProvider implements PaymentProvider {
  readonly key = "STRIPE";
  constructor(private o: { secretKey: string; webhookSecret: string; fetch?: typeof fetch }) {}

  async createPayment(i) {
    /* create PaymentIntent -> { providerOrderId, clientPayload: { clientSecret, publishableKey }, status: "PENDING" } */
  }
  async verifyPayment(i) {
    /* never trust the client: re-fetch the intent from Stripe and compare status + amount */
  }
  async handleWebhook(rawBody, headers) {
    /* verify signature over the RAW body first; return { eventId, type, providerOrderId, status } */
  }
  async refundPayment(i) {
    /* pass i.idempotencyKey to Stripe so retries cannot double-refund */
  }
}
```

Rules every payment adapter must follow:

1. **Verify signatures with the raw body** and compare in constant time (`crypto.timingSafeEqual`).
2. `eventId` must be stable per provider event so replays de-duplicate (unique `(provider, eventId)`).
3. **Amounts are decimal strings** at the boundary; convert to the provider's minor units with `toMinor` from `@kash-commerce/shared`.
4. `clientPayload` goes to the browser: **never include secrets**.
5. Provider failures throw `AppError(502, "PROVIDER_ERROR", <safe message>)` - never include the provider body or credentials.
6. Use an injectable `fetch` so the adapter is unit-testable without network (see `providers/payment/razorpay.ts` + its tests).

## Register it

```ts
// apps/api/src/providers/build.ts
if (deps.env.STRIPE_SECRET_KEY && deps.env.STRIPE_WEBHOOK_SECRET)
  providers.payment.STRIPE = new StripeProvider({ secretKey: ..., webhookSecret: ... });
```

Add the env vars to `packages/config/src/index.ts` (zod schema + the "required when active" check), to `.env.example`, to
`docker-compose.prod.yml.example`, and the provider key to the `PAYMENT_PROVIDER` enum. Webhook route: the payments module
mounts `/api/v1/webhooks/<provider-key-lowercase>` for every registered payment provider automatically.

## Shipping provider

Implement `ShippingProvider` (`getRates`, `createShipment`, `cancelShipment`, `trackShipment`). Rules: tokens cached with
single-flight login; retry only idempotent GETs; never retry shipment creation; map failures to `PROVIDER_ERROR`. The Admin
"create shipment" action calls the active provider and degrades gracefully (the shipment row is saved as FAILED and the
order is untouched).

## Notification provider (SMS / WhatsApp)

`NotificationProvider` has a `channel` and `send({ to, subject, body })`. Register under
`providers.notification.<KEY>` and select with the matching env var. Templates are per event (`order.confirmation`,
`order.status`, `order.shipped`, `password.reset`, `return.update`, `refund.processed`, `customer.welcome`,
`customer.verify`) and can be overridden in the `NotificationTemplate` table.

## Storage provider

Implement `StorageProvider` (`put`, `delete`, `url`, optional `read`). S3-compatible storage already covers AWS S3,
Cloudflare R2 and MinIO via `S3_ENDPOINT`.

## Testing a new provider

Unit-test it with a fake `fetch` (request shape, signature pass/fail/tamper, error mapping, "no secret in error or
clientPayload"). Then add an integration test using the existing MOCK flow as the template.
