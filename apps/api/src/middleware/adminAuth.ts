import type { RequestHandler } from "express";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../context";
import { safeEqual, sha256 } from "../lib/crypto";
import { h } from "../lib/http";

export const ADMIN_COOKIE = "kc_admin";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Loads the admin principal from the session cookie, enforcing:
 * - valid, non-revoked, non-expired, non-rotated token
 * - active account
 * - CSRF header (double submit against the per-session token) on unsafe methods
 */
export function adminAuth(ctx: AppContext): RequestHandler {
  return h(async (req, _res, next) => {
    const token = req.cookies?.[ADMIN_COOKIE] as string | undefined;
    if (!token) throw AppError.unauthenticated();
    const session = await ctx.prisma.adminSession.findUnique({
      where: { refreshTokenHash: sha256(token) },
      include: {
        adminUser: {
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        },
      },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date())
      throw AppError.unauthenticated();
    const user = session.adminUser;
    if (!user.isActive) throw AppError.unauthenticated("Account deactivated");
    if (!SAFE.has(req.method)) {
      const sent = req.header("x-csrf-token");
      if (!sent || !safeEqual(sent, session.csrfToken)) {
        throw new AppError(403, "CSRF_FAILED", "Missing or invalid CSRF token");
      }
    }
    req.admin = {
      id: user.id,
      email: user.email,
      name: user.name,
      roleKey: user.role.key,
      permissions: new Set(user.role.permissions.map((rp) => rp.permission.key)),
      sessionId: session.id,
      csrfToken: session.csrfToken,
    };
    next();
  });
}

/** Require ALL listed permissions. */
export function requirePermission(...keys: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.admin) return next(AppError.unauthenticated());
    for (const k of keys) {
      if (!req.admin.permissions.has(k))
        return next(AppError.forbidden(`Missing permission: ${k}`));
    }
    next();
  };
}
