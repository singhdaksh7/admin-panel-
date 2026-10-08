import type { ModuleRegister } from "./types";
import { register as auth } from "./auth";
import { register as users } from "./users";
import { register as store } from "./store";

/**
 * Feature module registry. Append a line per module. Order = mount order.
 * (Keep one module per line to keep merges trivial.)
 */
export const modules: ModuleRegister[] = [auth, users, store];
