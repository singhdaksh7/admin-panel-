import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Cart, Prisma, PrismaClient, Tx } from "@kash-commerce/database";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { randomToken } from "../../lib/crypto";
import { customerAuth } from "../../middleware/customerAuth";
import { createLimiters } from "../../lib/rateLimits";
import { computeTotals, totalsDto } from "../checkout/totals";
import { loadCommerceSettings } from "../checkout/settings";
import { MAX_LINE_QTY, loadPricedLines } from "./pricing";
import { normalizeCode } from "../coupons/service";

export const CART_COOKIE = "kc_cart";
export const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DISTINCT_LINES = 50;

const qty = z.number().int().min(1).max(MAX_LINE_QTY);
const addBody = z.object({ variantId: z.string().min(1).max(64), quantity: qty.default(1) });
const patchBody = z.object({ quantity: z.number().int().min(0).max(MAX_LINE_QTY) });
const couponBody = z.object({ code: z.string().trim().min(1).max(40) });
const mergeBody = z.object({ cartToken: z.string().min(10).max(128).optional() }).default({});

const newExpiry = () => new Date(Date.now() + CART_TTL_MS);

/** Token from `X-Cart-Token` (wins) or the `kc_cart` cookie. */
export function cartTokenFrom(req: Request): string | undefined {
  const t = req.header("x-cart-token") || (req.cookies?.[CART_COOKIE] as string | undefined);
  return typeof t === "string" && t.length >= 10 && t.length <= 128 ? t : undefined;
}

const cartInclude = { items: { orderBy: { createdAt: "asc" } } } satisfies Prisma.CartInclude;
export type CartWithItems = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

/** Looks up a live cart for a customer or by anonymous token. */
export async function findCartBy(
  db: PrismaClient | Tx,
  who: { customerId?: string | null; token?: string | null },
): Promise<CartWithItems | null> {
  const now = new Date();
  if (who.customerId) {
    return db.cart.findFirst({
      where: { customerId: who.customerId, expiresAt: { gt: now } },
      orderBy: { updatedAt: "desc" },
      include: cartInclude,
    });
  }
  if (!who.token) return null;
  return db.cart.findFirst({
    where: { token: who.token, customerId: null, expiresAt: { gt: now } },
    include: cartInclude,
  });
}

/** The caller cart: customer cart when authenticated, otherwise by anonymous token (header wins). */
export async function findCart(
  ctx: AppContext,
  req: Request,
  tokenOverride?: string,
): Promise<CartWithItems | null> {
  return findCartBy(ctx.prisma, {
    customerId: req.customer?.id,
    token: tokenOverride ?? cartTokenFrom(req),
  });
}

export async function createCart(
  ctx: AppContext,
  customerId: string | null,
): Promise<CartWithItems> {
  const s = await loadCommerceSettings(ctx.prisma);
  return ctx.prisma.cart.create({
    data: { token: randomToken(24), customerId, currency: s.currency, expiresAt: newExpiry() },
    include: cartInclude,
  });
}

async function touch(ctx: AppContext, cart: Cart) {
  await ctx.prisma.cart.update({ where: { id: cart.id }, data: { expiresAt: newExpiry() } });
}

export async function cartView(ctx: AppContext, cart: CartWithItems | null, req: Request) {
  if (!cart) {
    const s = await loadCommerceSettings(ctx.prisma);
    return {
      token: null,
      currency: s.currency,
      items: [],
      itemCount: 0,
      subtotal: "0.00",
      discount: "0.00",
      tax: "0.00",
      taxInclusive: false,
      taxBreakdown: [],
      total: "0.00",
      shippingExcluded: true,
      couponCode: null,
      couponError: null,
      warnings: [],
    };
  }
  const t = await computeTotals(ctx, ctx.prisma, {
    items: cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
    couponCode: cart.couponCode,
    includeShipping: false,
    strict: false,
    customerId: req.customer?.id,
  });
  const dto = totalsDto(t);
  const all = await loadPricedLines(
    ctx.prisma,
    cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
    (k) => ctx.providers.storage.url(k),
  );
  const warnings = all
    .filter((l) => l.problems.length)
    .map((l) => ({
      variantId: l.variantId,
      title: l.productTitle,
      problems: l.problems,
      available: l.available,
    }));
  const removedIds = new Set(all.map((l) => l.variantId));
  for (const i of cart.items)
    if (!removedIds.has(i.variantId))
      warnings.push({
        variantId: i.variantId,
        title: "",
        problems: ["NOT_FOUND"],
        available: null,
      });
  return {
    token: cart.token,
    currency: dto.currency,
    items: dto.lines,
    unavailableItems: t.unavailable.map((l) => ({ variantId: l.variantId, title: l.productTitle })),
    itemCount: cart.items.reduce((a, i) => a + i.quantity, 0),
    subtotal: dto.subtotal,
    discount: dto.discount,
    tax: dto.tax,
    taxInclusive: dto.taxInclusive,
    taxBreakdown: dto.taxBreakdown,
    total: dto.total,
    shippingExcluded: true,
    couponCode: cart.couponCode,
    couponError: t.couponError,
    warnings,
  };
}

export function register(ctx: AppContext): ModuleRoutes {
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const p = ctx.prisma;
  const router = Router();
  const opt = customerAuth(ctx, { required: false });
  const required = customerAuth(ctx, { required: true });

  const setCookie = (res: Response, token: string) =>
    res.cookie(CART_COOKIE, token, {
      httpOnly: true,
      secure: ctx.env.COOKIE_SECURE,
      sameSite: "lax",
      path: "/api/v1",
      domain: ctx.env.COOKIE_DOMAIN || undefined,
      maxAge: CART_TTL_MS,
    });

  async function respond(req: Request, res: Response, cartId: string | null, status = 200) {
    const cart = cartId
      ? await p.cart.findUnique({ where: { id: cartId }, include: cartInclude })
      : null;
    if (cart) setCookie(res, cart.token);
    res.status(status).json(await cartView(ctx, cart, req));
  }

  /** Validates that `quantity` of the variant may be bought and returns the priced line. */
  async function assertAddable(variantId: string, quantity: number) {
    const [line] = await loadPricedLines(p, [{ variantId, quantity }], (k) =>
      ctx.providers.storage.url(k),
    );
    if (!line) throw AppError.notFound("Product variant");
    if (line.problems.includes("UNAVAILABLE"))
      throw AppError.conflict("This item is no longer available", { variantId });
    if (line.problems.includes("OUT_OF_STOCK") || line.problems.includes("INSUFFICIENT_STOCK"))
      throw AppError.outOfStock(
        line.available ? `Only ${line.available} available` : "Out of stock",
        { variantId, available: line.available },
      );
    return line;
  }

  router.get(
    "/cart",
    limiters.publicRead,
    opt,
    h(async (req, res) => {
      const cart = await findCart(ctx, req);
      if (cart) await touch(ctx, cart);
      res.json(await cartView(ctx, cart, req));
    }),
  );

  router.post(
    "/cart/items",
    limiters.write,
    opt,
    h(async (req, res) => {
      const b = parse(addBody, req.body);
      let cart = await findCart(ctx, req);
      const existing = cart?.items.find((i) => i.variantId === b.variantId);
      const newQty = (existing?.quantity ?? 0) + b.quantity;
      if (newQty > MAX_LINE_QTY)
        throw AppError.validation(`Maximum quantity per item is ${MAX_LINE_QTY}`);
      await assertAddable(b.variantId, newQty);
      if (!cart) cart = await createCart(ctx, req.customer?.id ?? null);
      else if (!existing && cart.items.length >= MAX_DISTINCT_LINES)
        throw AppError.validation("Cart is full");
      await p.cartItem.upsert({
        where: { cartId_variantId: { cartId: cart.id, variantId: b.variantId } },
        create: { cartId: cart.id, variantId: b.variantId, quantity: newQty },
        update: { quantity: newQty },
      });
      await touch(ctx, cart);
      await respond(req, res, cart.id, 201);
    }),
  );

  router.patch(
    "/cart/items/:variantId",
    limiters.write,
    opt,
    h(async (req, res) => {
      const variantId = String(req.params.variantId).slice(0, 64);
      const b = parse(patchBody, req.body);
      const cart = await findCart(ctx, req);
      const existing = cart?.items.find((i) => i.variantId === variantId);
      if (!cart || !existing) throw AppError.notFound("Cart item");
      if (b.quantity === 0) {
        await p.cartItem.delete({ where: { id: existing.id } });
      } else {
        await assertAddable(variantId, b.quantity);
        await p.cartItem.update({ where: { id: existing.id }, data: { quantity: b.quantity } });
      }
      await touch(ctx, cart);
      await respond(req, res, cart.id);
    }),
  );

  router.delete(
    "/cart/items/:variantId",
    limiters.write,
    opt,
    h(async (req, res) => {
      const variantId = String(req.params.variantId).slice(0, 64);
      const cart = await findCart(ctx, req);
      if (!cart) throw AppError.notFound("Cart");
      await p.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
      await touch(ctx, cart);
      await respond(req, res, cart.id);
    }),
  );

  router.post(
    "/cart/coupon",
    limiters.write,
    opt,
    h(async (req, res) => {
      const b = parse(couponBody, req.body);
      const cart = await findCart(ctx, req);
      if (!cart || cart.items.length === 0) throw AppError.validation("Cart is empty");
      const code = normalizeCode(b.code);
      // strict validation so the shopper gets the precise reason immediately
      await computeTotals(ctx, p, {
        items: cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        couponCode: code,
        includeShipping: false,
        strict: false,
        customerId: req.customer?.id,
      }).then((t) => {
        if (t.couponError)
          throw new AppError(422, "VALIDATION_ERROR", t.couponError.message, {
            reason: t.couponError.reason,
          });
      });
      await p.cart.update({ where: { id: cart.id }, data: { couponCode: code } });
      await respond(req, res, cart.id);
    }),
  );

  router.delete(
    "/cart/coupon",
    limiters.write,
    opt,
    h(async (req, res) => {
      const cart = await findCart(ctx, req);
      if (!cart) throw AppError.notFound("Cart");
      await p.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
      await respond(req, res, cart.id);
    }),
  );

  // anonymous -> customer cart merge (requires session + CSRF)
  router.post(
    "/cart/merge",
    limiters.write,
    required,
    h(async (req, res) => {
      const b = parse(mergeBody, req.body ?? {});
      const token = b.cartToken ?? cartTokenFrom(req);
      const customerId = req.customer!.id;
      const anon = token
        ? await p.cart.findFirst({
            where: { token, customerId: null, expiresAt: { gt: new Date() } },
            include: cartInclude,
          })
        : null;
      let target = await findCart(ctx, req);
      if (!target) target = await createCart(ctx, customerId);
      if (anon && anon.id !== target.id) {
        const have = new Map(target.items.map((i) => [i.variantId, i.quantity]));
        const targetId = target.id;
        for (const it of anon.items) {
          let want = Math.min(MAX_LINE_QTY, (have.get(it.variantId) ?? 0) + it.quantity);
          const [line] = await loadPricedLines(
            p,
            [{ variantId: it.variantId, quantity: want }],
            (k) => ctx.providers.storage.url(k),
          );
          if (!line || line.problems.includes("UNAVAILABLE")) continue;
          if (line.available != null) want = Math.min(want, line.available);
          if (want <= 0) continue;
          if (!have.has(it.variantId) && have.size >= MAX_DISTINCT_LINES) continue;
          have.set(it.variantId, want);
          await p.cartItem.upsert({
            where: { cartId_variantId: { cartId: targetId, variantId: it.variantId } },
            create: { cartId: targetId, variantId: it.variantId, quantity: want },
            update: { quantity: want },
          });
        }
        if (anon.couponCode && !target.couponCode)
          await p.cart.update({ where: { id: targetId }, data: { couponCode: anon.couponCode } });
        await p.cart.delete({ where: { id: anon.id } });
      }
      await touch(ctx, target);
      await respond(req, res, target.id);
    }),
  );

  return { public: router };
}
