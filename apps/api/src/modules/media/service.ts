import type { PrismaClient } from "@kash-commerce/database";

export type ImageType = "jpeg" | "png" | "webp" | "gif" | "avif";

export const IMAGE_META: Record<ImageType, { mime: string; ext: string; extensions: string[] }> = {
  jpeg: { mime: "image/jpeg", ext: "jpg", extensions: ["jpg", "jpeg"] },
  png: { mime: "image/png", ext: "png", extensions: ["png"] },
  webp: { mime: "image/webp", ext: "webp", extensions: ["webp"] },
  gif: { mime: "image/gif", ext: "gif", extensions: ["gif"] },
  avif: { mime: "image/avif", ext: "avif", extensions: ["avif"] },
};

export const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString("latin1");

/** Detect the real image type from magic bytes. SVG (and everything else) is intentionally unsupported. */
export function detectImageType(b: Buffer): ImageType | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "png";
  const head6 = ascii(b, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
  }
  return null;
}

export interface MediaReference {
  entity: string;
  field: string;
  count: number;
}

/** Everything that may point at a Media row. Page content (CMS JSON) is intentionally ignored. */
export async function findMediaReferences(
  prisma: PrismaClient,
  mediaId: string,
): Promise<MediaReference[]> {
  const [productImages, catImage, catBanner, collection, variants, logo, favicon, blog] =
    await Promise.all([
      prisma.productImage.count({ where: { mediaId } }),
      prisma.category.count({ where: { imageMediaId: mediaId } }),
      prisma.category.count({ where: { bannerMediaId: mediaId } }),
      prisma.collection.count({ where: { imageMediaId: mediaId } }),
      prisma.productVariant.count({ where: { imageMediaId: mediaId } }),
      prisma.storeSettings.count({ where: { logoMediaId: mediaId } }),
      prisma.storeSettings.count({ where: { faviconMediaId: mediaId } }),
      prisma.blogPost.count({ where: { coverMediaId: mediaId } }),
    ]);
  const all: MediaReference[] = [
    { entity: "ProductImage", field: "mediaId", count: productImages },
    { entity: "Category", field: "imageMediaId", count: catImage },
    { entity: "Category", field: "bannerMediaId", count: catBanner },
    { entity: "Collection", field: "imageMediaId", count: collection },
    { entity: "ProductVariant", field: "imageMediaId", count: variants },
    { entity: "StoreSettings", field: "logoMediaId", count: logo },
    { entity: "StoreSettings", field: "faviconMediaId", count: favicon },
    { entity: "BlogPost", field: "coverMediaId", count: blog },
  ];
  return all.filter((r) => r.count > 0);
}

/** Throws-free helper: do all ids exist as Media rows? Returns the missing ids. */
export async function missingMediaIds(prisma: PrismaClient, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await prisma.media.findMany({
    where: { id: { in: unique } },
    select: { id: true },
  });
  const have = new Set(found.map((m) => m.id));
  return unique.filter((i) => !have.has(i));
}
