import type { PrismaClient } from "@kash-commerce/database";
import type { Env } from "@kash-commerce/config";
import type { Logger } from "pino";
import type { Providers } from "./providers/index";

/** Dependencies injected into every module. Tests build their own context. */
export interface AppContext {
  env: Env;
  prisma: PrismaClient;
  logger: Logger;
  providers: Providers;
}
