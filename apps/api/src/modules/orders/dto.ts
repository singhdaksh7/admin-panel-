import type { Prisma } from "@kash-commerce/database";

export const publicOrderInclude = {
  items: { orderBy: { id: "asc" } },
  events: { orderBy: { createdAt: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.OrderInclude;

export type PublicOrder = Prisma.OrderGetPayload<{ include: typeof publicOrderInclude }>;

/** Customer/guest-facing projection: no actor ids, no provider internals. */
export function publicOrderDto(o: PublicOrder) {
  return {
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    currency: o.currency,
    email: o.email,
    subtotal: o.subtotal.toFixed(2),
    discount: o.discountTotal.toFixed(2),
    shipping: o.shippingTotal.toFixed(2),
    tax: o.taxTotal.toFixed(2),
    taxBreakdown: o.taxBreakdown,
    total: o.total.toFixed(2),
    couponCode: o.couponCode,
    shippingMethod: o.shippingMethodName,
    shippingAddress: o.shippingAddress,
    billingAddress: o.billingAddress,
    paymentProvider: o.paymentProvider,
    placedAt: o.placedAt,
    cancelledAt: o.cancelledAt,
    items: o.items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
      title: i.productTitle,
      variantTitle: i.variantTitle,
      sku: i.sku,
      imageUrl: i.imageUrl,
      attributes: i.attributes,
      unitPrice: i.unitPrice.toFixed(2),
      quantity: i.quantity,
      discount: i.discount.toFixed(2),
      taxRate: i.taxRate.toString(),
      taxAmount: i.taxAmount.toFixed(2),
      lineTotal: i.lineTotal.toFixed(2),
    })),
    timeline: o.events
      .filter((e) => e.type !== "NOTE")
      .map((e) => ({ type: e.type, toStatus: e.toStatus, message: e.message, at: e.createdAt })),
    payments: o.payments.map((p) => ({
      provider: p.provider,
      status: p.status,
      amount: p.amount.toFixed(2),
    })),
  };
}
