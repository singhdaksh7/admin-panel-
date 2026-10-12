import { prisma } from "./helpers";

let n = 0;
const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

export async function mkCategory(name: string, parentId?: string | null, extra: object = {}) {
  return prisma.category.create({
    data: {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      parentId: parentId ?? null,
      ...extra,
    },
  });
}

export async function mkMedia(key = `m-${uid()}.jpg`) {
  return prisma.media.create({
    data: {
      storageKey: key,
      provider: "LOCAL",
      filename: key,
      mimeType: "image/jpeg",
      sizeBytes: 10,
    },
  });
}

export interface ProductOpts {
  slug: string;
  title?: string;
  categoryId?: string | null;
  status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  publishAt?: Date | null;
  price?: string;
  onHand?: number | null; // null = untracked / no inventory row
  tagIds?: string[];
  attributeValueIds?: string[]; // product-level
  variantAttributeValueIds?: string[]; // on the default variant
  collectionIds?: string[];
  properties?: object;
  isFeatured?: boolean;
  mediaId?: string;
}

export async function mkProduct(o: ProductOpts) {
  const product = await prisma.product.create({
    data: {
      slug: o.slug,
      title: o.title ?? o.slug,
      status: o.status ?? "ACTIVE",
      categoryId: o.categoryId ?? null,
      publishAt: o.publishAt ?? null,
      isFeatured: o.isFeatured ?? false,
      ...(o.properties ? { properties: o.properties } : {}),
      variants: {
        create: {
          sku: `sku-${o.slug}`,
          price: o.price ?? "10.00",
          isDefault: true,
          ...(o.variantAttributeValueIds
            ? {
                attributes: {
                  create: o.variantAttributeValueIds.map((attributeValueId) => ({
                    attributeValueId,
                  })),
                },
              }
            : {}),
          ...(o.onHand !== null && o.onHand !== undefined
            ? { inventory: { create: { onHand: o.onHand, trackInventory: true } } }
            : {}),
        },
      },
      ...(o.tagIds ? { tags: { create: o.tagIds.map((tagId) => ({ tagId })) } } : {}),
      ...(o.attributeValueIds
        ? {
            attributeValues: {
              create: o.attributeValueIds.map((attributeValueId) => ({ attributeValueId })),
            },
          }
        : {}),
      ...(o.collectionIds
        ? { collections: { create: o.collectionIds.map((collectionId) => ({ collectionId })) } }
        : {}),
      ...(o.mediaId ? { images: { create: { mediaId: o.mediaId } } } : {}),
    },
    include: { variants: true },
  });
  return product;
}

export async function mkAttribute(name: string, values: string[]) {
  const a = await prisma.attribute.create({
    data: {
      name,
      slug: name.toLowerCase(),
      values: { create: values.map((v, i) => ({ value: v, slug: v.toLowerCase(), sortOrder: i })) },
    },
    include: { values: true },
  });
  return a;
}
