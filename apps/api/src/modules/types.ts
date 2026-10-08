import type { Router } from "express";
import type { AppContext } from "../context";

/**
 * Every feature module exports `register(ctx)` returning any of:
 *  - public:   mounted at /api/v1            (storefront API; no admin auth)
 *  - admin:    mounted at /api/v1/admin      (admin session + CSRF already enforced; add requirePermission per route)
 *  - webhooks: mounted at /api/v1/webhooks   (raw body available as req.rawBody)
 */
export interface ModuleRoutes {
  public?: Router;
  admin?: Router;
  /** mounted at /api/v1/admin/auth BEFORE admin session auth (login, refresh, reset...) */
  adminPublic?: Router;
  webhooks?: Router;
}
export type ModuleRegister = (ctx: AppContext) => ModuleRoutes;
