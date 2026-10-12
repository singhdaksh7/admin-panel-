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
    subtotal: o.subtotal.toString(),
    discount: o.discountTotal.toString(),
    shipping: o.shippingTotal.toString(),
    tax: o.taxTotal.toString(),
    taxBreakdown: o.taxBreakdown,
    total: o.total.toString(),
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
      unitPrice: i.unitPrice.toString(),
      quantity: i.quantity,
      discount: i.discount.toString(),
      taxRate: i.taxRate.toString(),
      taxAmount: i.taxAmount.toString(),
      lineTotal: i.lineTotal.toString(),
    })),
    timeline: o.events
      .filter((e) => e.type !== "NOTE")
      .map((e) => ({ type: e.type, toStatus: e.toStatus, message: e.message, at: e.createdAt })),
    payments: o.payments.map((p) => ({
      provider: p.provider,
      status: p.status,
      amount: p.amount.toString(),
    })),
  };
}
