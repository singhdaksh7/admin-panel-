-- DB-level invariants that Prisma cannot express.
ALTER TABLE "InventoryItem" ADD CONSTRAINT "inventory_onhand_nonneg" CHECK ("onHand" >= 0 OR "allowBackorder");
ALTER TABLE "InventoryItem" ADD CONSTRAINT "inventory_reserved_nonneg" CHECK ("reserved" >= 0);
ALTER TABLE "Review" ADD CONSTRAINT "review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "CartItem" ADD CONSTRAINT "cartitem_qty_positive" CHECK ("quantity" > 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "orderitem_qty_positive" CHECK ("quantity" > 0);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "variant_price_nonneg" CHECK ("price" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "order_total_nonneg" CHECK ("total" >= 0);
CREATE UNIQUE INDEX "one_default_variant_per_product" ON "ProductVariant" ("productId") WHERE "isDefault";
