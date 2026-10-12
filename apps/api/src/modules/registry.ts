import type { ModuleRegister } from "./types";
import { register as auth } from "./auth";
import { register as users } from "./users";
import { register as store } from "./store";
import { register as customers } from "./customers";
import { register as cart } from "./cart";
import { register as coupons } from "./coupons";
import { register as shippingMethods } from "./shipping-methods";
import { register as checkout } from "./checkout";
import { register as orders } from "./orders";

/**
 * Feature module registry. Append a line per module. Order = mount order.
 * (Keep one module per line to keep merges trivial.)
 */
export const modules: ModuleRegister[] = [
  auth,
  users,
  store,
  customers,
  cart,
  coupons,
  shippingMethods,
  checkout,
  orders,
];
