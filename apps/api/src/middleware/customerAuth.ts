import type { RequestHandler } from "express";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../context";
import { safeEqual, sha256 } from "../lib/crypto";
import { h } from "../lib/http";

export const CUSTOMER_COOKIE = "kc_customer";
export const CUSTOMER_COOKIE_PATH = "/api/v1";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Loads the customer principal from the `kc_customer` session cookie (same design as admin sessions:
 * opaque token, only its SHA-256 stored, per-session CSRF token required on unsafe methods).
 *
 *  - required: true  -> 401 without a valid session, 403 CSRF_FAILED on a bad/missing CSRF header
 *  - required: false -> never fails. If the session is missing/invalid, or an unsafe request lacks a
 *    valid CSRF header, the request simply proceeds as an ANONYMOUS (guest) request, so a cross-site
 *    request can never act with the customer's identity.
 */
export function customerAuth(ctx: AppContext, opts: { required: boolean }): RequestHandler {
  return h(async (req, _res, next) => {
    const token = req.cookies?.[CUSTOMER_COOKIE] as string | undefined;
    const fail = (e: AppError) => {
      if (opts.required) throw e;
      return next();
    };
    if (!token) return fail(AppError.unauthenticated());
    const session = await ctx.prisma.customerSession.findUnique({
      where: { refreshTokenHash: sha256(token) },
      include: { customer: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date())
      return fail(AppError.unauthenticated());
    if (!session.customer.isActive) return fail(AppError.unauthenticated("Account deactivated"));
    if (!SAFE.has(req.method)) {
      const sent = req.header("x-csrf-token");
      if (!sent || !safeEqual(sent, session.csrfToken))
        return fail(new AppError(403, "CSRF_FAILED", "Missing or invalid CSRF token"));
    }
    req.customer = {
      id: session.customer.id,
      email: session.customer.email,
      sessionId: session.id,
      csrfToken: session.csrfToken,
    };
    next();
  });
}
