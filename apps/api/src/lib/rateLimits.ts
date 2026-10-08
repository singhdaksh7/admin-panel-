import rateLimit, { type Options } from "express-rate-limit";
import type { RequestHandler } from "express";

/**
 * Rate-limit classes are SEPARATE so that heavy storefront browsing / QA can never
 * lock out login, checkout or admin work (a known failure of single global limiters).
 */
function make(opts: Partial<Options>, enabled: boolean): RequestHandler {
  if (!enabled) return (_req, _res, next) => next();
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests, please slow down" } },
    ...opts,
  });
}

export interface Limiters {
  publicRead: RequestHandler; // storefront GETs: generous
  auth: RequestHandler; // login/register/reset: strict, failures only
  checkout: RequestHandler; // checkout & payment
  adminApi: RequestHandler; // authenticated admin traffic
  write: RequestHandler; // public mutating requests (cart, reviews)
  webhook: RequestHandler; // provider webhooks
}

export function createLimiters(enabled: boolean): Limiters {
  const min = 60 * 1000;
  return {
    publicRead: make({ windowMs: min, limit: 600 }, enabled),
    auth: make({ windowMs: 15 * min, limit: 20, skipSuccessfulRequests: true }, enabled),
    checkout: make({ windowMs: min, limit: 30 }, enabled),
    adminApi: make({ windowMs: min, limit: 1200 }, enabled),
    write: make({ windowMs: min, limit: 120 }, enabled),
    webhook: make({ windowMs: min, limit: 300 }, enabled),
  };
}
