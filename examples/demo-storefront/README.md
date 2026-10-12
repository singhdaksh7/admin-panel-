# Demo storefront

A deliberately small Vite + React + react-router storefront that uses **only** `@kash-commerce/storefront-sdk`.
It is the integration proof for the public API; copy what you need.

```bash
cp .env.example .env            # VITE_COMMERCE_API_URL=http://localhost:4000
npm run dev -w demo-storefront  # http://localhost:5173 (add it to the API's CORS_ORIGINS)
```

Optional demo data (needs admin credentials, dev only):

```bash
COMMERCE_API_URL=http://localhost:4000 COMMERCE_ADMIN_EMAIL=... COMMERCE_ADMIN_PASSWORD=... \
  node examples/demo-storefront/scripts/seed.mjs
```

Payments: choose **Cash on delivery** (MANUAL, confirms instantly). With a non-production API running the MOCK
provider, "Pay online" shows a clearly-labelled DEMO ONLY "Simulate payment" button. See
`docs/STOREFRONT_INTEGRATION.md` for the Razorpay flow.

`npm test -w demo-storefront` (React Testing Library with a mocked SDK), `npm run typecheck -w demo-storefront`,
`npm run build -w demo-storefront`.
