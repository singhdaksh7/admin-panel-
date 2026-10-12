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
];
