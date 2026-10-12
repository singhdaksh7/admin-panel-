import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { Prisma } from "@kash-commerce/database";
import { AppError, slugify } from "@kash-commerce/shared";

/** Money in API bodies: decimal string, max 2 fraction digits, never a float. */
export const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "Must be a decimal string like 12.50");

export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug may contain lowercase letters, digits and hyphens");

export const seoSchema = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    ogImageMediaId: z.string().max(64).nullable().optional(),
    noIndex: z.boolean().optional(),
  })
  .strict();

export const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

/** Find a free slug: base, base-2, base-3, ... */
export async function uniqueSlug(
  taken: (slug: string) => Promise<boolean>,
  base: string,
): Promise<string> {
  const root = slugify(base);
  let candidate = root;
  for (let i = 2; await taken(candidate); i++) {
    candidate = `${root.slice(0, 110)}-${i}`;
    if (i > 500) throw AppError.conflict("Could not allocate a unique slug");
  }
  return candidate;
}

const RICH_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "ul",
    "ol",
    "li",
    "h2",
    "h3",
    "h4",
    "blockquote",
    "a",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
    "span",
    "code",
    "pre",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow" }),
  },
};

export function sanitizeRich(html: string): string {
  return sanitizeHtml(html, RICH_OPTS);
}

export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  if (!field) return true;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? "").includes(field);
}

export function isFkViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";
}

export const dec = (v: string | null | undefined) => (v == null ? null : new Prisma.Decimal(v));
export const str = (d: Prisma.Decimal | null | undefined) => (d == null ? null : d.toFixed(2));
