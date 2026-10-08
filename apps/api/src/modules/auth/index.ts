import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import {
  hashPassword,
  passwordProblems,
  randomToken,
  sha256,
  verifyPassword,
} from "../../lib/crypto";
import { ADMIN_COOKIE, adminAuth } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { notify } from "../notifications/service";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // sliding absolute window per rotated token
const MAX_FAILS = 5;

const loginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});
const changePwBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
const forgotBody = z.object({ email: z.string().email().max(254) });
const resetBody = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(1).max(200),
});

function setSessionCookie(ctx: AppContext, res: Response, token: string) {
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: ctx.env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/api/v1/admin",
    domain: ctx.env.COOKIE_DOMAIN || undefined,
    maxAge: SESSION_TTL_MS,
  });
}
function clearSessionCookie(ctx: AppContext, res: Response) {
  res.clearCookie(ADMIN_COOKIE, {
    path: "/api/v1/admin",
    domain: ctx.env.COOKIE_DOMAIN || undefined,
  });
}

async function createSession(
  ctx: AppContext,
  req: Request,
  adminUserId: string,
  familyId?: string,
) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const session = await ctx.prisma.adminSession.create({
    data: {
      adminUserId,
      refreshTokenHash: sha256(token),
      familyId: familyId ?? randomToken(12),
      csrfToken,
      userAgent: req.header("user-agent")?.slice(0, 300),
      ip: req.ip,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return { token, csrfToken, session };
}

function principalDto(p: NonNullable<Request["admin"]>) {
  return {
    id: p.id,
    email: p.email,
    name: p.name,
    role: p.roleKey,
    permissions: [...p.permissions].sort(),
    csrfToken: p.csrfToken,
  };
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const router = Router();
  const authed = adminAuth(ctx);

  // The admin router is mounted behind adminAuth by default; auth endpoints must be mounted
  // BEFORE that — app.ts mounts `authPublic` at /api/v1/admin/auth (no session required).
  router.post(
    "/login",
    limiters.auth,
    h(async (req, res) => {
      const { email, password } = parse(loginBody, req.body);
      const user = await ctx.prisma.adminUser.findUnique({
        where: { email: email.toLowerCase() },
        include: { role: true },
      });
      const generic = AppError.unauthenticated("Invalid email or password");
      if (!user) {
        await hashPassword(password); // equalise timing
        throw generic;
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new AppError(429, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
      }
      const ok = await verifyPassword(user.passwordHash, password);
      if (!ok || !user.isActive) {
        if (!ok) {
          const fails = user.failedLoginCount + 1;
          const lock =
            fails >= MAX_FAILS
              ? new Date(Date.now() + Math.min(30, 2 ** (fails - MAX_FAILS)) * 60 * 1000)
              : null;
          await ctx.prisma.adminUser.update({
            where: { id: user.id },
            data: { failedLoginCount: fails, lockedUntil: lock },
          });
        }
        throw generic;
      }
      await ctx.prisma.adminUser.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      });
      const { token, csrfToken } = await createSession(ctx, req, user.id);
      setSessionCookie(ctx, res, token);
      req.admin = {
        id: user.id,
        email: user.email,
        name: user.name,
        roleKey: user.role.key,
        permissions: new Set(),
        sessionId: "",
        csrfToken,
      };
      await audit(ctx, req, { action: "auth.login", entityType: "AdminUser", entityId: user.id });
      const perms = await ctx.prisma.rolePermission.findMany({
        where: { roleId: user.roleId },
        include: { permission: true },
      });
      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role.key,
          permissions: perms.map((p) => p.permission.key).sort(),
          mustChangePassword: user.mustChangePassword,
        },
        csrfToken,
      });
    }),
  );

  // Rotation: presenting the current session cookie yields a new token; reuse of a rotated token kills the family.
  router.post(
    "/refresh",
    limiters.auth,
    h(async (req, res) => {
      const token = req.cookies?.[ADMIN_COOKIE] as string | undefined;
      if (!token) throw AppError.unauthenticated();
      const old = await ctx.prisma.adminSession.findUnique({
        where: { refreshTokenHash: sha256(token) },
      });
      if (!old) throw AppError.unauthenticated();
      if (old.revokedAt || old.replacedById) {
        await ctx.prisma.adminSession.updateMany({
          where: { familyId: old.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        clearSessionCookie(ctx, res);
        throw AppError.unauthenticated("Session invalidated");
      }
      if (old.expiresAt < new Date()) throw AppError.unauthenticated();
      const user = await ctx.prisma.adminUser.findUnique({
        where: { id: old.adminUserId },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      });
      if (!user || !user.isActive) throw AppError.unauthenticated();
      const fresh = await createSession(ctx, req, user.id, old.familyId);
      await ctx.prisma.adminSession.update({
        where: { id: old.id },
        data: { replacedById: fresh.session.id, revokedAt: new Date() },
      });
      setSessionCookie(ctx, res, fresh.token);
      res.json({ csrfToken: fresh.csrfToken });
    }),
  );

  router.post(
    "/logout",
    h(async (req, res) => {
      const token = req.cookies?.[ADMIN_COOKIE] as string | undefined;
      if (token) {
        const s = await ctx.prisma.adminSession.findUnique({
          where: { refreshTokenHash: sha256(token) },
        });
        if (s) {
          // CSRF-protect logout when a valid session exists
          const sent = req.header("x-csrf-token");
          if (sent && sent === s.csrfToken) {
            await ctx.prisma.adminSession.updateMany({
              where: { familyId: s.familyId, revokedAt: null },
              data: { revokedAt: new Date() },
            });
          } else {
            throw new AppError(403, "CSRF_FAILED", "Missing or invalid CSRF token");
          }
        }
      }
      clearSessionCookie(ctx, res);
      res.json({ ok: true });
    }),
  );

  router.get("/me", authed, (req, res) => {
    res.json({ user: principalDto(req.admin!) });
  });

  router.post(
    "/change-password",
    authed,
    h(async (req, res) => {
      const { currentPassword, newPassword } = parse(changePwBody, req.body);
      const user = await ctx.prisma.adminUser.findUniqueOrThrow({ where: { id: req.admin!.id } });
      if (!(await verifyPassword(user.passwordHash, currentPassword)))
        throw AppError.validation("Current password is incorrect");
      const problems = passwordProblems(newPassword);
      if (problems.length) throw AppError.validation(`Password ${problems.join(", ")}`);
      await ctx.prisma.adminUser.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(newPassword),
          passwordChangedAt: new Date(),
          mustChangePassword: false,
        },
      });
      // revoke all other sessions
      await ctx.prisma.adminSession.updateMany({
        where: { adminUserId: user.id, id: { not: req.admin!.sessionId }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(ctx, req, {
        action: "auth.password_change",
        entityType: "AdminUser",
        entityId: user.id,
      });
      res.json({ ok: true });
    }),
  );

  router.post(
    "/forgot-password",
    limiters.auth,
    h(async (req, res) => {
      const { email } = parse(forgotBody, req.body);
      const user = await ctx.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
      if (user?.isActive) {
        const token = randomToken(32);
        await ctx.prisma.adminPasswordReset.create({
          data: {
            adminUserId: user.id,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        const base = ctx.env.CORS_ORIGINS[0] ?? ctx.env.PUBLIC_API_URL;
        await notify(ctx, "password.reset", user.email, {
          name: user.name,
          link: `${base}/reset-password?token=${token}`,
        });
      }
      res.json({ ok: true }); // never reveal whether the account exists
    }),
  );

  router.post(
    "/reset-password",
    limiters.auth,
    h(async (req, res) => {
      const { token, newPassword } = parse(resetBody, req.body);
      const problems = passwordProblems(newPassword);
      if (problems.length) throw AppError.validation(`Password ${problems.join(", ")}`);
      const row = await ctx.prisma.adminPasswordReset.findUnique({
        where: { tokenHash: sha256(token) },
      });
      if (!row || row.usedAt || row.expiresAt < new Date())
        throw AppError.badRequest("Reset link is invalid or expired");
      await ctx.prisma.$transaction([
        ctx.prisma.adminPasswordReset.update({
          where: { id: row.id },
          data: { usedAt: new Date() },
        }),
        ctx.prisma.adminUser.update({
          where: { id: row.adminUserId },
          data: {
            passwordHash: await hashPassword(newPassword),
            passwordChangedAt: new Date(),
            failedLoginCount: 0,
            lockedUntil: null,
            mustChangePassword: false,
          },
        }),
        ctx.prisma.adminSession.updateMany({
          where: { adminUserId: row.adminUserId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
      res.json({ ok: true });
    }),
  );

  return { adminPublic: router };
}
