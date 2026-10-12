import type { ModuleRegister } from "./types";
import { register as auth } from "./auth";
import { register as users } from "./users";
import { register as store } from "./store";
import { register as catalog } from "./catalog";
import { register as inventory } from "./inventory";
import { register as media } from "./media";
import { register as content } from "./content";
import { register as navigation } from "./navigation";
import { register as filters } from "./filters";
import { register as reviews } from "./reviews";
import { register as blog } from "./blog";
import { register as seo } from "./seo";
import { register as customers } from "./customers";
import { register as cart } from "./cart";
import { register as coupons } from "./coupons";
import { register as shippingMethods } from "./shipping-methods";
import { register as checkout } from "./checkout";
import { register as orders } from "./orders";
import { register as payments } from "./payments";
import { register as shipments } from "./shipments";
import { register as returns } from "./returns";
import { register as invoices } from "./invoices";
import { register as integrations } from "./integrations";

/**
 * Feature module registry. Order = mount order.
 * Public routes are mounted in this order, so specific routes (e.g. /products/:slug/reviews)
 * must not be shadowed by earlier catch-all params.
 */
export const modules: ModuleRegister[] = [
  auth,
  users,
  store,
  catalog,
  inventory,
  media,
  content,
  navigation,
  filters,
  reviews,
  blog,
  seo,
  customers,
  cart,
  coupons,
  shippingMethods,
  checkout,
  orders,
  payments,
  shipments,
  returns,
  invoices,
  integrations,
];
