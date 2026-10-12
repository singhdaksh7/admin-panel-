import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Customer, Prisma } from "@kash-commerce/database";
import { AppError, clampPage, paginated } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import {
  hashPassword,
  passwordProblems,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from "../../lib/crypto";
import { CUSTOMER_COOKIE, CUSTOMER_COOKIE_PATH, customerAuth } from "../../middleware/customerAuth";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { notify } from "../notifications/service";
import { loadCommerceSettings } from "../checkout/settings";
import { publicOrderDto, publicOrderInclude } from "../orders/dto";

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const MAX_ADDRESSES = 20;
const VERIFY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Stateless email-verification token: base64url(payload).hmac. Proves control of the mailbox,
 * which is required before earlier GUEST orders are attached to an account (otherwise anyone could
 * register with a victim's email address and read their order history).
 */
export function makeVerifyToken(secret: string, customerId: string, emailAddr: string): string {
  const payload = Buffer.from(
    JSON.stringify({ c: customerId, e: emailAddr, x: Date.now() + VERIFY_TTL_MS }),
  ).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(`verify:${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}

function readVerifyToken(secret: string, token: string): { c: string; e: string } | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expect = crypto
    .createHmac("sha256", secret)
    .update(`verify:${payload}`)
    .digest("base64url");
  if (!safeEqual(mac, expect)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      c: string;
      e: string;
      x: number;
    };
    return d.x > Date.now() ? { c: d.c, e: d.e } : null;
  } catch {
    return null;
  }
}

const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
const registerBody = z.object({
  email,
  password: z.string().min(1).max(200),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(30).optional(),
});
const loginBody = z.object({ email, password: z.string().min(1).max(200) });
const profileBody = z
  .object({
    firstName: z.string().trim().max(80).nullable(),
    lastName: z.string().trim().max(80).nullable(),
    phone: z.string().trim().max(30).nullable(),
  })
  .partial();
const changePwBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
const forgotBody = z.object({ email });
const resetBody = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(1).max(200),
});

export const addressBody = z.object({
  label: z.string().trim().max(40).nullish(),
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).nullish(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().max(100).nullish(),
  postalCode: z.string().trim().min(1).max(20),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase()),
  isDefaultShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
});

function customerDto(c: Customer) {
  return {
    id: c.id,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    emailVerified: c.emailVerified,
    createdAt: c.createdAt,
  };
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const router = Router();
  const admin = Router();
  const authed = customerAuth(ctx, { required: true });

  /** Attach earlier GUEST orders (same email) to a customer whose mailbox ownership is proven. */
  async function claimGuestOrders(customerId: string, emailAddr: string) {
    await p.order.updateMany({
      where: { customerId: null, email: emailAddr },
      data: { customerId },
    });
  }

  async function sendVerification(c: Customer) {
    const token = makeVerifyToken(ctx.env.SESSION_SECRET, c.id, c.email);
    const base = ctx.env.CORS_ORIGINS[0] ?? ctx.env.PUBLIC_API_URL;
    await notify(ctx, "customer.verify", c.email, {
      name: c.firstName ?? c.email,
      link: `${base}/account/verify-email?token=${token}`,
    });
  }

  // Failed-login backoff (Customer has no lockout columns). Per-process; the auth rate limiter backs it up.
  const throttle = new Map<string, { fails: number; until: number }>();
  const lockedFor = (key: string) => {
    const t = throttle.get(key);
    return t && t.until > Date.now() ? t.until - Date.now() : 0;
  };
  const recordFail = (key: string) => {
    if (throttle.size > 10_000) throttle.clear();
    const t = throttle.get(key) ?? { fails: 0, until: 0 };
    t.fails++;
    if (t.fails >= MAX_FAILS)
      t.until = Date.now() + Math.min(30, 2 ** (t.fails - MAX_FAILS)) * 60_000;
    throttle.set(key, t);
  };

  const setCookie = (res: Response, token: string) =>
    res.cookie(CUSTOMER_COOKIE, token, {
      httpOnly: true,
      secure: ctx.env.COOKIE_SECURE,
      sameSite: "lax",
      path: CUSTOMER_COOKIE_PATH,
      domain: ctx.env.COOKIE_DOMAIN || undefined,
      maxAge: SESSION_TTL_MS,
    });
  const clearCookie = (res: Response) =>
    res.clearCookie(CUSTOMER_COOKIE, {
      path: CUSTOMER_COOKIE_PATH,
      domain: ctx.env.COOKIE_DOMAIN || undefined,
    });

  async function createSession(req: Request, customerId: string, familyId?: string) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const session = await p.customerSession.create({
      data: {
        customerId,
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

  // Every /account route (except none) is gated by the customerAccounts feature flag.
  router.use(
    "/account",
    h(async (_req, _res, next) => {
      if (!(await loadCommerceSettings(p)).customerAccounts)
        throw AppError.forbidden("Customer accounts are disabled");
      next();
    }),
  );

  router.post(
    "/account/register",
    limiters.auth,
    h(async (req, res) => {
      const b = parse(registerBody, req.body);
      const problems = passwordProblems(b.password);
      if (problems.length) throw AppError.validation(`Password ${problems.join(", ")}`);
      const existing = await p.customer.findUnique({ where: { email: b.email } });
      if (existing && existing.passwordHash)
        throw AppError.conflict("An account with this email already exists");
      const passwordHash = await hashPassword(b.password);
      const data = {
        passwordHash,
        isGuest: false,
        firstName: b.firstName ?? existing?.firstName ?? null,
        lastName: b.lastName ?? existing?.lastName ?? null,
        phone: b.phone ?? existing?.phone ?? null,
      };
      let customer: Customer;
      try {
        customer = await p.$transaction(async (tx) => {
          const c = existing
            ? await tx.customer.update({ where: { id: existing.id }, data })
            : await tx.customer.create({ data: { email: b.email, ...data } });
          // NOTE: earlier guest orders are NOT attached here. That happens only after the email
          // address is verified (verify-email / password reset) - see claimGuestOrders().
          return c;
        });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002")
          throw AppError.conflict("An account with this email already exists");
        throw e;
      }
      const { token, csrfToken } = await createSession(req, customer.id);
      setCookie(res, token);
      await notify(ctx, "customer.welcome", customer.email, {
        name: customer.firstName ?? customer.email,
      });
      await sendVerification(customer);
      res.status(201).json({ customer: customerDto(customer), csrfToken });
    }),
  );

  router.post(
    "/account/login",
    limiters.auth,
    h(async (req, res) => {
      const { email: addr, password } = parse(loginBody, req.body);
      const generic = AppError.unauthenticated("Invalid email or password");
      if (lockedFor(addr))
        throw new AppError(429, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
      const customer = await p.customer.findUnique({ where: { email: addr } });
      if (!customer || !customer.passwordHash) {
        await hashPassword(password); // equalise timing
        recordFail(addr);
        throw generic;
      }
      const ok = await verifyPassword(customer.passwordHash, password);
      if (!ok || !customer.isActive) {
        if (!ok) recordFail(addr);
        throw generic;
      }
      throttle.delete(addr);
      const { token, csrfToken } = await createSession(req, customer.id);
      setCookie(res, token);
      res.json({ customer: customerDto(customer), csrfToken });
    }),
  );

  router.post(
    "/account/refresh",
    limiters.auth,
    h(async (req, res) => {
      const token = req.cookies?.[CUSTOMER_COOKIE] as string | undefined;
      if (!token) throw AppError.unauthenticated();
      const old = await p.customerSession.findUnique({
        where: { refreshTokenHash: sha256(token) },
      });
      if (!old) throw AppError.unauthenticated();
      if (old.revokedAt) {
        // a rotated/revoked token was replayed => theft suspected, kill the whole family
        await p.customerSession.updateMany({
          where: { familyId: old.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        clearCookie(res);
        throw AppError.unauthenticated("Session invalidated");
      }
      if (old.expiresAt < new Date()) throw AppError.unauthenticated();
      const customer = await p.customer.findUnique({ where: { id: old.customerId } });
      if (!customer || !customer.isActive) throw AppError.unauthenticated();
      // atomically retire the old token; a concurrent refresh with the same token loses
      const claimed = await p.customerSession.updateMany({
        where: { id: old.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) throw AppError.unauthenticated("Session invalidated");
      const fresh = await createSession(req, customer.id, old.familyId);
      setCookie(res, fresh.token);
      res.json({ customer: customerDto(customer), csrfToken: fresh.csrfToken });
    }),
  );

  router.post(
    "/account/logout",
    h(async (req, res) => {
      const token = req.cookies?.[CUSTOMER_COOKIE] as string | undefined;
      if (token) {
        const s = await p.customerSession.findUnique({
          where: { refreshTokenHash: sha256(token) },
        });
        if (s) {
          const sent = req.header("x-csrf-token");
          if (!sent || !safeEqual(sent, s.csrfToken))
            throw new AppError(403, "CSRF_FAILED", "Missing or invalid CSRF token");
          await p.customerSession.updateMany({
            where: { familyId: s.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
      }
      clearCookie(res);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/account/verify-email",
    limiters.auth,
    h(async (req, res) => {
      const { token } = parse(z.object({ token: z.string().min(20).max(1000) }), req.body);
      const t = readVerifyToken(ctx.env.SESSION_SECRET, token);
      const c = t ? await p.customer.findUnique({ where: { id: t.c } }) : null;
      if (!t || !c || c.email !== t.e)
        throw AppError.badRequest("Verification link is invalid or expired");
      if (!c.emailVerified)
        await p.customer.update({ where: { id: c.id }, data: { emailVerified: true } });
      await claimGuestOrders(c.id, c.email);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/account/resend-verification",
    limiters.auth,
    authed,
    h(async (req, res) => {
      const c = await p.customer.findUniqueOrThrow({ where: { id: req.customer!.id } });
      if (!c.emailVerified) await sendVerification(c);
      res.json({ ok: true });
    }),
  );

  router.get(
    "/account/me",
    authed,
    h(async (req, res) => {
      const c = await p.customer.findUniqueOrThrow({ where: { id: req.customer!.id } });
      res.json({ customer: customerDto(c), csrfToken: req.customer!.csrfToken });
    }),
  );

  router.patch(
    "/account/me",
    authed,
    h(async (req, res) => {
      const b = parse(profileBody, req.body);
      const c = await p.customer.update({ where: { id: req.customer!.id }, data: b });
      res.json({ customer: customerDto(c) });
    }),
  );

  router.post(
    "/account/change-password",
    authed,
    limiters.auth,
    h(async (req, res) => {
      const b = parse(changePwBody, req.body);
      const c = await p.customer.findUniqueOrThrow({ where: { id: req.customer!.id } });
      if (!c.passwordHash || !(await verifyPassword(c.passwordHash, b.currentPassword)))
        throw AppError.validation("Current password is incorrect");
      const problems = passwordProblems(b.newPassword);
      if (problems.length) throw AppError.validation(`Password ${problems.join(", ")}`);
      await p.customer.update({
        where: { id: c.id },
        data: { passwordHash: await hashPassword(b.newPassword) },
      });
      await p.customerSession.updateMany({
        where: { customerId: c.id, id: { not: req.customer!.sessionId }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      res.json({ ok: true });
    }),
  );

  router.post(
    "/account/forgot-password",
    limiters.auth,
    h(async (req, res) => {
      const { email: addr } = parse(forgotBody, req.body);
      const c = await p.customer.findUnique({ where: { email: addr } });
      if (c?.isActive && c.passwordHash) {
        const token = randomToken(32);
        await p.customerPasswordReset.create({
          data: {
            customerId: c.id,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + 60 * 60_000),
          },
        });
        const base = ctx.env.CORS_ORIGINS[0] ?? ctx.env.PUBLIC_API_URL;
        await notify(ctx, "password.reset", c.email, {
          name: c.firstName ?? c.email,
          link: `${base}/account/reset-password?token=${token}`,
        });
      }
      res.json({ ok: true }); // identical response whether or not the account exists
    }),
  );

  router.post(
    "/account/reset-password",
    limiters.auth,
    h(async (req, res) => {
      const b = parse(resetBody, req.body);
      const problems = passwordProblems(b.newPassword);
      if (problems.length) throw AppError.validation(`Password ${problems.join(", ")}`);
      const row = await p.customerPasswordReset.findUnique({
        where: { tokenHash: sha256(b.token) },
      });
      if (!row || row.usedAt || row.expiresAt < new Date())
        throw AppError.badRequest("Reset link is invalid or expired");
      const passwordHash = await hashPassword(b.newPassword);
      await p.$transaction(async (tx) => {
        const claimed = await tx.customerPasswordReset.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (claimed.count === 0) throw AppError.badRequest("Reset link is invalid or expired");
        await tx.customer.update({
          where: { id: row.customerId },
          data: { passwordHash, emailVerified: true },
        });
        await tx.customerSession.updateMany({
          where: { customerId: row.customerId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
      const owner = await p.customer.findUnique({ where: { id: row.customerId } });
      if (owner) await claimGuestOrders(owner.id, owner.email); // reset proves mailbox control
      res.json({ ok: true });
    }),
  );

  // ───────── addresses (always scoped by the session's customerId => IDOR-proof) ─────────
  router.get(
    "/account/addresses",
    authed,
    h(async (req, res) => {
      const items = await p.address.findMany({
        where: { customerId: req.customer!.id },
        orderBy: { createdAt: "asc" },
      });
      res.json({ items });
    }),
  );

  router.post(
    "/account/addresses",
    authed,
    limiters.write,
    h(async (req, res) => {
      const b = parse(addressBody, req.body);
      const cid = req.customer!.id;
      const created = await p.$transaction(async (tx) => {
        const count = await tx.address.count({ where: { customerId: cid } });
        if (count >= MAX_ADDRESSES) throw AppError.validation("Address limit reached");
        const first = count === 0;
        const ship = b.isDefaultShipping ?? first;
        const bill = b.isDefaultBilling ?? first;
        if (ship)
          await tx.address.updateMany({
            where: { customerId: cid },
            data: { isDefaultShipping: false },
          });
        if (bill)
          await tx.address.updateMany({
            where: { customerId: cid },
            data: { isDefaultBilling: false },
          });
        return tx.address.create({
          data: { ...b, customerId: cid, isDefaultShipping: ship, isDefaultBilling: bill },
        });
      });
      res.status(201).json(created);
    }),
  );

  router.patch(
    "/account/addresses/:id",
    authed,
    limiters.write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(addressBody.partial(), req.body);
      const cid = req.customer!.id;
      const updated = await p.$transaction(async (tx) => {
        const own = await tx.address.findFirst({ where: { id, customerId: cid } });
        if (!own) throw AppError.notFound("Address");
        if (b.isDefaultShipping)
          await tx.address.updateMany({
            where: { customerId: cid },
            data: { isDefaultShipping: false },
          });
        if (b.isDefaultBilling)
          await tx.address.updateMany({
            where: { customerId: cid },
            data: { isDefaultBilling: false },
          });
        return tx.address.update({ where: { id }, data: b });
      });
      res.json(updated);
    }),
  );

  router.delete(
    "/account/addresses/:id",
    authed,
    limiters.write,
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const r = await p.address.deleteMany({ where: { id, customerId: req.customer!.id } });
      if (r.count === 0) throw AppError.notFound("Address");
      res.json({ ok: true });
    }),
  );

  // ───────── order history (own orders only) ─────────
  router.get(
    "/account/orders",
    authed,
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const where: Prisma.OrderWhereInput = { customerId: req.customer!.id };
      const [rows, total] = await Promise.all([
        p.order.findMany({
          where,
          include: publicOrderInclude,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        p.order.count({ where }),
      ]);
      res.json(paginated(rows.map(publicOrderDto), total, { page, pageSize }));
    }),
  );

  router.get(
    "/account/orders/:orderNumber",
    authed,
    h(async (req, res) => {
      const orderNumber = String(req.params.orderNumber).slice(0, 40);
      const o = await p.order.findFirst({
        where: { orderNumber, customerId: req.customer!.id },
        include: publicOrderInclude,
      });
      if (!o) throw AppError.notFound("Order");
      res.json(publicOrderDto(o));
    }),
  );

  // ───────── admin ─────────
  admin.get(
    "/customers",
    requirePermission("customers.read"),
    h(async (req, res) => {
      const { page, pageSize } = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const where: Prisma.CustomerWhereInput = {
        ...(q
          ? {
              OR: [
                { email: { contains: q, mode: "insensitive" } },
                { firstName: { contains: q, mode: "insensitive" } },
                { lastName: { contains: q, mode: "insensitive" } },
                { phone: { contains: q } },
              ],
            }
          : {}),
        ...(req.query.active === "true" ? { isActive: true } : {}),
        ...(req.query.active === "false" ? { isActive: false } : {}),
      };
      const [rows, total] = await Promise.all([
        p.customer.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { _count: { select: { orders: true } } },
        }),
        p.customer.count({ where }),
      ]);
      res.json(
        paginated(
          rows.map((c) => ({
            ...customerDto(c),
            isActive: c.isActive,
            isGuest: c.isGuest,
            orderCount: c._count.orders,
          })),
          total,
          { page, pageSize },
        ),
      );
    }),
  );

  admin.get(
    "/customers/:id",
    requirePermission("customers.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const c = await p.customer.findUnique({ where: { id }, include: { addresses: true } });
      if (!c) throw AppError.notFound("Customer");
      const [agg, recent] = await Promise.all([
        p.order.aggregate({
          where: { customerId: id, status: { notIn: ["CANCELLED", "REFUNDED"] } },
          _count: true,
          _sum: { total: true },
        }),
        p.order.findMany({
          where: { customerId: id },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            total: true,
            currency: true,
            placedAt: true,
          },
        }),
      ]);
      res.json({
        ...customerDto(c),
        isActive: c.isActive,
        isGuest: c.isGuest,
        addresses: c.addresses,
        ordersSummary: {
          count: agg._count,
          totalSpent: (agg._sum.total ?? 0).toFixed(2),
          recent: recent.map((o) => ({ ...o, total: o.total.toFixed(2) })),
        },
      });
    }),
  );

  admin.patch(
    "/customers/:id",
    requirePermission("customers.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(
        z
          .object({
            isActive: z.boolean(),
            firstName: z.string().trim().max(80).nullable(),
            lastName: z.string().trim().max(80).nullable(),
            phone: z.string().trim().max(30).nullable(),
          })
          .partial(),
        req.body,
      );
      const before = await p.customer.findUnique({ where: { id } });
      if (!before) throw AppError.notFound("Customer");
      const after = await p.customer.update({ where: { id }, data: b });
      if (b.isActive === false)
        await p.customerSession.updateMany({
          where: { customerId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      await audit(ctx, req, {
        action: b.isActive === false ? "customer.deactivate" : "customer.update",
        entityType: "Customer",
        entityId: id,
        before: { isActive: before.isActive },
        after: b,
      });
      res.json({ ...customerDto(after), isActive: after.isActive });
    }),
  );

  return { public: router, admin };
}
