import type { Express } from "express";
import type { OrderStatus } from "@kash-commerce/database";
import { prisma, request } from "./helpers";
import { addToCart, checkout, seedProduct } from "./commerceHelpers";
import { signMockPayment } from "../src/providers/payment/mock";
import { transitionOrder } from "../src/modules/orders/service";
import type { AppContext } from "../src/context";

export const SYS = { type: "SYSTEM" as const };

export interface Placed {
  order: Awaited<ReturnType<typeof prisma.order.findUniqueOrThrow>>;
  variantId: string;
  productId: string;
  payment: Awaited<ReturnType<typeof prisma.payment.findFirstOrThrow>>;
  clientPayload: Record<string, unknown> | null;
  email: string;
}

/** Places an order through the real checkout. Default provider: the active one (MOCK). */
export async function placeOrder(
  app: Express,
  opts: {
    qty?: number;
    stock?: number;
    price?: string;
    provider?: string;
    email?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Placed> {
  const { variant, product } = await seedProduct({
    stock: opts.stock ?? 20,
    price: opts.price ?? "10.00",
  });
  const token = await addToCart(app, variant.id, opts.qty ?? 2);
  const email = opts.email ?? "buyer@example.com";
  const r = await checkout(
    app,
    token,
    { email, ...(opts.provider ? { paymentProvider: opts.provider } : {}) },
    opts.headers,
  );
  if (r.status !== 201) throw new Error(`place failed ${r.status} ${JSON.stringify(r.body)}`);
  const order = await prisma.order.findUniqueOrThrow({
    where: { orderNumber: r.body.order.orderNumber },
  });
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
  return {
    order,
    variantId: variant.id,
    productId: product.id,
    payment,
    clientPayload: r.body.clientPayload,
    email,
  };
}

export function verifyBody(placed: Placed, paymentId = "pay_test_1", over: object = {}) {
  return {
    orderNumber: placed.order.orderNumber,
    email: placed.email,
    providerOrderId: placed.payment.providerOrderId!,
    providerPaymentId: paymentId,
    signature: signMockPayment(placed.payment.providerOrderId!, paymentId),
    ...over,
  };
}

/** Pays through the public verify endpoint (confirms the order). */
export async function payViaVerify(app: Express, placed: Placed) {
  const r = await request(app).post("/api/v1/payments/verify").send(verifyBody(placed));
  if (r.status !== 200) throw new Error(`verify failed ${r.status} ${JSON.stringify(r.body)}`);
}

const PATH: OrderStatus[] = ["CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "DELIVERED"];

/** Walks the order through the allowed transitions up to `to`. */
export async function advanceTo(ctx: AppContext, orderId: string, to: OrderStatus) {
  const idx = PATH.indexOf(to);
  for (let i = 0; i <= idx; i++) {
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (PATH.indexOf(o.status) >= i) continue;
    await transitionOrder(ctx, orderId, PATH[i]!, SYS);
  }
}

/** Order that is paid and DELIVERED (ready for returns). */
export async function deliveredOrder(
  app: Express,
  ctx: AppContext,
  opts: Parameters<typeof placeOrder>[1] = {},
) {
  const placed = await placeOrder(app, opts);
  await payViaVerify(app, placed);
  await advanceTo(ctx, placed.order.id, "DELIVERED");
  return placed;
}
