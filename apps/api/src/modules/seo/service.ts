import type { PrismaClient } from "@kash-commerce/database";

export interface EntitySeo {
  title?: string | null;
  description?: string | null;
  canonicalUrl?: string | null;
  ogImageMediaId?: string | null;
  noindex?: boolean | null;
  nofollow?: boolean | null;
}

/** Store-wide SEO defaults, persisted in IntegrationSetting(kind=SEO, provider=DEFAULTS).config. */
export interface SeoDefaults {
  /** "%s | My Store" - %s is replaced with the entity title */
  titleTemplate: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultOgImageMediaId: string | null;
  /** "index" | "noindex" - store-wide robots default (noindex = hide whole site, e.g. staging) */
  robots: "index" | "noindex";
  /** absolute storefront origin used to build absolute URLs in JSON-LD, e.g. https://shop.example.com */
  siteUrl: string | null;
}

export const DEFAULT_SEO: SeoDefaults = {
  titleTemplate: "%s",
  defaultTitle: "",
  defaultDescription: "",
  defaultOgImageMediaId: null,
  robots: "index",
  siteUrl: null,
};

export interface ResolvedSeo {
  title: string;
  description: string;
  canonicalUrl: string | null;
  ogImageMediaId: string | null;
  noindex: boolean;
  nofollow: boolean;
  robots: string;
}

export async function getSeoDefaults(prisma: PrismaClient): Promise<SeoDefaults> {
  const row = await prisma.integrationSetting.findUnique({
    where: { kind_provider: { kind: "SEO", provider: "DEFAULTS" } },
  });
  return { ...DEFAULT_SEO, ...((row?.config ?? {}) as Partial<SeoDefaults>) };
}

/**
 * Merge an entity's own SEO with store defaults. Entity values win; the entity title is wrapped in
 * `titleTemplate`; `fallback` (e.g. the product title) is used when the entity has no seo title.
 * A store-wide noindex default cannot be overridden by an entity (staging safety).
 */
export function resolveSeo(
  entitySeo: EntitySeo | null | undefined,
  defaults: Partial<SeoDefaults> | null | undefined,
  fallback: { title?: string | null; description?: string | null } = {},
): ResolvedSeo {
  const d = { ...DEFAULT_SEO, ...(defaults ?? {}) };
  const e = entitySeo ?? {};
  const rawTitle = e.title || fallback.title || d.defaultTitle;
  const title = rawTitle ? d.titleTemplate.replace("%s", rawTitle) : "";
  const storeNoindex = d.robots === "noindex";
  const noindex = storeNoindex || e.noindex === true;
  const nofollow = storeNoindex || e.nofollow === true;
  return {
    title,
    description: e.description || fallback.description || d.defaultDescription,
    canonicalUrl: e.canonicalUrl ?? null,
    ogImageMediaId: e.ogImageMediaId || d.defaultOgImageMediaId || null,
    noindex,
    nofollow,
    robots: `${noindex ? "noindex" : "index"},${nofollow ? "nofollow" : "follow"}`,
  };
}
