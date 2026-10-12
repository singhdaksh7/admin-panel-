import type { ModuleRegister } from "./types";
import { register as auth } from "./auth";
import { register as users } from "./users";
import { register as store } from "./store";
import { register as catalog } from "./catalog";
import { register as inventory } from "./inventory";
import { register as media } from "./media";

/**
 * Feature module registry. Append a line per module. Order = mount order.
 * (Keep one module per line to keep merges trivial.)
 */
export const modules: ModuleRegister[] = [auth, users, store];
modules.push(catalog);
modules.push(inventory);
modules.push(media);
