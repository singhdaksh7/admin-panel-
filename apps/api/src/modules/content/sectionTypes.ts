import { z } from "zod";
import { AppError } from "@kash-commerce/shared";
import { sanitizeRichHtml } from "./sanitize";

/**
 * Section type -> zod content schema. To add a section type: add a schema here and (if it needs
 * resolved data on the public page) a resolver in ./resolve.ts.
 */

const mediaId = z.string().min(1).max(64);
const slug = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a slug (lowercase letters, digits, hyphens)");
const safeUrl = z
  .string()
  .min(1)
  .max(1000)
  .refine((u) => /^(\/(?!\/)|https?:\/\/|mailto:|tel:|#)/i.test(u), {
    message: "must be a relative path (/...), http(s) URL, mailto: or tel:",
  });

/** Responsive asset pair: desktop required for the section to render, mobile falls back to desktop. */
export const responsiveAsset = z
  .object({
    desktopMediaId: mediaId.optional(),
    mobileMediaId: mediaId.optional(),
    alt: z.string().max(300).optional(),
  })
  .strict();
export const cta = z.object({ label: z.string().min(1).max(60), url: safeUrl }).strict();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex colour like #112233");
const limit = (max: number, def: number) => z.number().int().min(1).max(max).default(def);

export const SECTION_SCHEMAS = {
  HERO: z
    .object({
      heading: z.string().min(1).max(200),
      subheading: z.string().max(500).optional(),
      image: responsiveAsset.optional(),
      cta: cta.optional(),
      secondaryCta: cta.optional(),
      align: z.enum(["left", "center", "right"]).default("left"),
      overlayOpacity: z.number().min(0).max(1).optional(),
    })
    .strict(),
  PROMO_BANNER: z
    .object({
      text: z.string().min(1).max(300),
      cta: cta.optional(),
      image: responsiveAsset.optional(),
      backgroundColor: hexColor.optional(),
      textColor: hexColor.optional(),
    })
    .strict(),
  TEXT: z
    .object({
      heading: z.string().max(200).optional(),
      body: z
        .string()
        .min(1)
        .max(20_000)
        .transform((v) => sanitizeRichHtml(v)),
      align: z.enum(["left", "center", "right"]).default("left"),
    })
    .strict(),
  IMAGE: z
    .object({
      image: responsiveAsset.refine((a) => !!a.desktopMediaId, {
        message: "desktopMediaId is required",
        path: ["desktopMediaId"],
      }),
      linkUrl: safeUrl.optional(),
      caption: z.string().max(300).optional(),
    })
    .strict(),
  PRODUCT_GRID: z
    .object({
      heading: z.string().max(200).optional(),
      productIds: z.array(z.string().min(1).max(64)).max(48).optional(),
      productSlugs: z.array(slug).max(48).optional(),
      categorySlug: slug.optional(),
      categoryId: z.string().min(1).max(64).optional(),
      collectionSlug: slug.optional(),
      featuredOnly: z.boolean().optional(),
      sort: z.enum(["manual", "newest", "featured"]).default("newest"),
      limit: limit(48, 8),
      cta: cta.optional(),
    })
    .strict(),
  CATEGORY_GRID: z
    .object({
      heading: z.string().max(200).optional(),
      categoryIds: z.array(z.string().min(1).max(64)).max(48).optional(),
      categorySlugs: z.array(slug).max(48).optional(),
      parentSlug: slug.optional(),
      limit: limit(48, 8),
    })
    .strict(),
  RICH_TEXT: z
    .object({
      html: z
        .string()
        .min(1)
        .max(100_000)
        .transform((v) => sanitizeRichHtml(v)),
    })
    .strict(),
  REVIEWS: z
    .object({
      heading: z.string().max(200).optional(),
      productSlug: slug.optional(),
      minRating: z.number().int().min(1).max(5).optional(),
      limit: limit(24, 6),
    })
    .strict(),
  BLOG_PREVIEW: z
    .object({
      heading: z.string().max(200).optional(),
      tag: z.string().min(1).max(60).optional(),
      limit: limit(24, 3),
    })
    .strict(),
  CUSTOM_JSON: z.record(z.unknown()).superRefine((v, ctx) => {
    if (Buffer.byteLength(JSON.stringify(v), "utf8") > CUSTOM_JSON_MAX_BYTES)
      ctx.addIssue({
        code: "custom",
        message: `CUSTOM_JSON content must be <= ${CUSTOM_JSON_MAX_BYTES} bytes`,
      });
  }),
} as const;

export const CUSTOM_JSON_MAX_BYTES = 64 * 1024;
export type SectionType = keyof typeof SECTION_SCHEMAS;
export const SECTION_TYPES = Object.keys(SECTION_SCHEMAS) as [SectionType, ...SectionType[]];
export const sectionTypeEnum = z.enum(SECTION_TYPES);

/** Validate (and normalize: defaults, sanitized HTML) section content. Throws a precise 422. */
export function validateSectionContent(type: string, content: unknown): Record<string, unknown> {
  const schema = SECTION_SCHEMAS[type as SectionType];
  if (!schema) throw AppError.validation(`Unknown section type "${type}"`);
  const r = schema.safeParse(content);
  if (!r.success) {
    throw AppError.validation(
      `Invalid content for section type ${type}`,
      r.error.issues.map((i) => ({ path: ["content", ...i.path].join("."), message: i.message })),
    );
  }
  return r.data as Record<string, unknown>;
}

/** Media ids referenced by a (validated) content object: any key ending in "MediaId". */
export function collectMediaIds(content: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(content)) content.forEach((c) => collectMediaIds(c, out));
  else if (content && typeof content === "object") {
    for (const [k, v] of Object.entries(content)) {
      if (k.endsWith("MediaId") && typeof v === "string") out.add(v);
      else collectMediaIds(v, out);
    }
  }
  return out;
}
