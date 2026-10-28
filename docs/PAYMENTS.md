# Payments

Payment providers implement one interface (`packages/provider-sdk` -> `PaymentProvider`): `createPayment`, `verifyPayment`,
`handleWebhook`, `refundPayment`. The active provider is chosen with `PAYMENT_PROVIDER`.

| Provider   | Use                                                      | Notes                                                    |
| ---------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `MANUAL`   | Cash on delivery / bank transfer                         | Order is confirmed immediately; admin marks it paid      |
| `CASHFREE` | Online payments (India - Cards, UPI, Netbanking, Wallets)| Native PG v2023-08-01; Sandbox and Production support    |
| `RAZORPAY` | Online payments (India)                                  | Needs 3 env secrets; webhook recommended                 |
| `MOCK`     | Automated tests and local demos                          | **Refused in production** (`NODE_ENV=production`)        |

Adding Stripe/Cashfree/PayPal: `docs/EXTENDING_PROVIDERS.md`.

## Flow (online payment)

```
storefront                      API                                  provider
checkout.create() ───────────►  reserve stock, create Order+Payment
                                 createPayment() ──────────────────►  create order
◄── { order, paymentRequired, clientPayload }   (no secrets)
open provider checkout with clientPayload ─────────────────────────►  customer pays
◄── provider returns { order_id, payment_id, signature } to the browser
payments.verify() ───────────►  verifyPayment(): HMAC check + amount check
                                 markPaymentStatus(PAID) -> order CONFIRMED, stock committed
                                                     ▲
                                 webhook (authoritative, async) ◄─────  payment.captured
```

The browser result is a convenience: **the server verifies the signature itself** and cross-checks that the stored payment
amount equals the order total. The webhook independently marks the payment paid, so an order completes even if the customer
closes the tab. Both paths are idempotent.

## Razorpay setup

1. Razorpay dashboard -> API keys. Set (environment only):
   ```
   PAYMENT_PROVIDER=RAZORPAY
   RAZORPAY_KEY_ID=...        RAZORPAY_KEY_SECRET=...        RAZORPAY_WEBHOOK_SECRET=...
   ```
   The API refuses to start with `PAYMENT_PROVIDER=RAZORPAY` if any of the three is missing.
2. Dashboard -> Webhooks -> add `https://<api-origin>/api/v1/webhooks/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`,
   events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`.
3. Storefront: pass `clientPayload` (`keyId`, `providerOrderId`, `amount` in **minor units**, `currency`) to Razorpay Checkout,
   then call `commerce.payments.verify({ orderNumber, email, providerOrderId, providerPaymentId, signature })`.
   See `docs/STOREFRONT_INTEGRATION.md`.

## Cashfree PG setup (API v2023-08-01)

1. Cashfree Merchant Dashboard -> Developers -> API Keys. Set:
   ```bash
   PAYMENT_PROVIDER=CASHFREE
   CASHFREE_APP_ID=your_cashfree_app_id
   CASHFREE_SECRET_KEY=your_cashfree_secret_key
   CASHFREE_ENV=production  # or "sandbox" for test mode
   ```
   The API validates that both App ID and Secret Key are present when `PAYMENT_PROVIDER=CASHFREE`.
2. Cashfree Dashboard -> Webhooks -> Add endpoint:
   - Webhook URL: `https://<api-origin>/api/v1/webhooks/cashfree`
   - Subscribed Events: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`, `REFUND_STATUS_WEBHOOK`.
   - Signature format: Cashfree sends Base64-encoded `HMAC-SHA256(timestamp + rawBody, secretKey)` in header `x-webhook-signature`.
3. Storefront flow:
   - On checkout creation, Kash Commerce returns `clientPayload.paymentSessionId`.
   - Storefront initialises Cashfree JS SDK (`load({ mode: "production" })`) and invokes `checkout({ paymentSessionId })`.
   - Storefront then verifies via `commerce.payments.verify({ orderNumber, email, providerOrderId })`.

## Safety properties (covered by tests)

- Webhook signature is verified over the **raw body** before anything is parsed; a bad signature returns 401.
- Replays are processed **exactly once**: a unique `(provider, eventId)` row is the only gate, so even 5 parallel
  deliveries of the same event apply once.
- Amount mismatch or unknown payment -> recorded on the `WebhookEvent`, never marks anything paid, still answers 200 so the
  provider stops retrying.
- A forged signature can never change a PAID payment; a FAILED payment can later become PAID with a valid signature.
- Retrying payment (`commerce.payments.retry`) is allowed only when the latest attempt failed.
- Unpaid pending orders are cancelled after 60 minutes and their reserved stock is released.

## Refunds

Admin -> Orders -> order -> **Refund**, or via a return (Admin -> Returns). The payment row is locked, the refundable
amount (payment total - already refunded - pending refunds) is enforced, and the provider receives the refund id as its
idempotency key, so a double click cannot refund twice. A provider failure marks the refund FAILED and releases the
reservation. For `MANUAL` payments the refund stays PENDING until an admin marks it processed after paying the customer back.

## Going live checklist

- [ ] Live-mode keys in env, `PAYMENT_PROVIDER=RAZORPAY`, API restarted
- [ ] Webhook registered with the **live** secret; send a test event and see it processed (`WebhookEvent` row)
- [ ] One real low-value order paid, visible as PAID in Admin, invoice downloadable
- [ ] One refund issued and confirmed in the provider dashboard
