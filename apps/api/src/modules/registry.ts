import type { ModuleRegister } from "./types";
import { register as auth } from "./auth";
import { register as users } from "./users";
import { register as store } from "./store";
import { register as content } from "./content";
import { register as navigation } from "./navigation";
import { register as filters } from "./filters";
import { register as reviews } from "./reviews";
import { register as blog } from "./blog";
import { register as seo } from "./seo";

/**
 * Feature module registry. Append a line per module. Order = mount order.
 * (Keep one module per line to keep merges trivial.)
 */
export const modules: ModuleRegister[] = [auth, users, store];
modules.push(content, navigation, filters, reviews, blog, seo);
