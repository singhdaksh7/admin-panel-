# Shipping

Two separate concepts:

1. **Shipping methods** (what the customer chooses at checkout and what it costs) - configured in the Admin / API, provider
   independent: `FLAT`, `FREE_OVER` (free above a subtotal) and a provider-rate placeholder. Optional country restriction,
   delivery estimate, active flag, ordering.
2. **Shipping providers** (who physically moves the parcel) - create a shipment, get an AWB and tracking, cancel. Chosen with
   `SHIPPING_PROVIDER`.

| Provider     | Use                                    | Notes                                                              |
| ------------ | -------------------------------------- | ------------------------------------------------------------------ |
| `MANUAL`     | Any carrier handled by hand            | Admin types the carrier/AWB/tracking URL                           |
| `SHIPROCKET` | Automatic AWB, tracking, cancellation  | Needs `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`                    |
| `MOCK`       | Tests/demos                            | Deterministic rates, fake AWB, simulated tracking                  |

## Configure checkout shipping methods

Admin -> **Store Settings** area / shipping methods API (`/api/v1/admin/shipping-methods`, permission `settings.write`).
Example: "Standard" flat 5.00, "Free shipping" free over 50.00. The price is **always computed on the server**; a client cannot
pick a cheaper price. Without any active method, checkout falls back to zero shipping.

## Shiprocket setup

1. Create an API user in Shiprocket (not your login) and set `SHIPPING_PROVIDER=SHIPROCKET`, `SHIPROCKET_EMAIL`,
   `SHIPROCKET_PASSWORD` in the environment.
2. Admin -> **Integrations** -> Shipping -> Shiprocket: set the non-secret options `pickupLocation` (the pickup nickname
   configured in Shiprocket, default "Primary") and `pickupPostcode`. Rates require `pickupPostcode`.
3. Admin -> Orders -> a **PACKED** order -> **Create shipment**. The provider returns the shipment id, AWB, carrier and
   tracking URL, and the order moves to SHIPPED (customer gets the shipped email).

Behaviour you can rely on:

- Token is cached with a single in-flight login (no login storms) and re-login happens once on a 401.
- Only idempotent reads are retried; shipment creation is never retried automatically.
- Provider failure is graceful: the shipment row is saved as `FAILED` with a safe message, the API answers 502, and the order is
  untouched - fix the issue and try again (or enter the AWB manually).
- Customers see tracking at `GET /api/v1/orders/:orderNumber/tracking?email=` (SDK: `commerce.orders.tracking`). Admin can
  *Refresh tracking*; a DELIVERED result moves the order to DELIVERED.

## Limitations

- Shiprocket status-code mapping and the cancel-after-restart lookup were written from the public API docs and have not been
  exercised against a live Shiprocket account (no credentials were available). Run one test shipment before launch.
- Cancelling a shipment does not move the order back from SHIPPED (the order state machine is forward-only); add a note instead.
- Shipping is not taxed by the tax engine in this version.
