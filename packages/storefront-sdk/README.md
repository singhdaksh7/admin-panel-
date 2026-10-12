# @kash-commerce/storefront-sdk

Typed, zero-dependency client for the Kash Commerce public storefront API (`/api/v1`). Works in browsers,
Node 18+ and SSR.

```ts
import { createCommerceClient } from "@kash-commerce/storefront-sdk";

const commerce = createCommerceClient({ baseUrl: "https://api.myshop.com" });
const { items } = await commerce.products.list({ category: "t-shirts", sort: "price_asc" });
await commerce.cart.add({ variantId: items[0].id, quantity: 1 });
```

Full guide, flows (cart, checkout, payments, auth/CSRF, CMS sections, SEO) and a method reference:
[`docs/STOREFRONT_INTEGRATION.md`](../../docs/STOREFRONT_INTEGRATION.md).

- `npm test -w @kash-commerce/storefront-sdk` - unit tests (fake fetch)
- `COMMERCE_API_URL=http://localhost:4000 npm test -w @kash-commerce/storefront-sdk` - also runs the contract
  suite against a real API
- `npm run build -w @kash-commerce/storefront-sdk` - emits `dist/` (ESM + types)
