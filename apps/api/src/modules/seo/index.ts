import { Router } from "express";
import { z } from "zod";
import { AppError } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { publishedWhere } from "../../lib/productQuery";
import { getSettings, publicSettings } from "../store";
import { getRatingAggregates } from "../reviews/service";
import { isPublishedNow, mediaUrlMap } from "../content/resolve";
import { getSeoDefaults, resolveSeo, type EntitySeo, type SeoDefaults } from "./service";

export { resolveSeo, getSeoDefaults } from "./service";

const SITEMAP_CAP = 50_000;
const DISALLOW = ["/cart", "/checkout", "/account", "/api/", "/search"];

const defaultsBody = z
  .object({
    titleTemplate: z
      .string()
      .max(120)
      .refine((v) => v.includes("%s"), { message: "must contain %s" }),
    defaultTitle: z.string().max(200),
    defaultDescription: z.string().max(500),
    defaultOgImageMediaId: z.string().max(64).nullable(),
    robots: z.enum(["index", "noindex"]),
    siteUrl: z.string().url().max(300).nullable(),
  })
  .partial()
  .strict();

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");

  const pub = Router();
  pub.use("/seo", limiters.publicRead);

  pub.get(
    "/seo/defaults",
    h(async (_req, res) => {
      const d = await getSeoDefaults(p);
      const urls = await mediaUrlMap(ctx, [d.defaultOgImageMediaId]);
      res.set("Cache-Control", "public, max-age=60");
      res.json({
        ...d,
        defaultOgImageUrl: d.defaultOgImageMediaId
          ? (urls.get(d.defaultOgImageMediaId) ?? null)
          : null,
      });
    }),
  );

  pub.get(
    "/seo/robots",
    h(async (_req, res) => {
      const d = await getSeoDefaults(p);
      res.set("Cache-Control", "public, max-age=300");
      res.json({
        allow: d.robots !== "noindex",
        disallow: d.robots === "noindex" ? ["/"] : DISALLOW,
        sitemapPath: "/sitemap.xml",
        siteUrl: d.siteUrl,
      });
    }),
  );

  pub.get(
    "/seo/sitemap",
    h(async (_req, res) => {
      const now = new Date();
      let budget = SITEMAP_CAP;
      const take = () => Math.max(0, budget);
      const noindex = (seo: unknown) => (seo as { noindex?: boolean } | null)?.noindex === true;

      const products = await p.product.findMany({
        where: publishedWhere(now),
        select: { slug: true, updatedAt: true, seo: true },
        orderBy: { updatedAt: "desc" },
        take: take(),
      });
      const productsOut = products
        .filter((x) => !noindex(x.seo))
        .map(({ slug, updatedAt }) => ({ slug, updatedAt }));
      budget -= productsOut.length;
      const categories = (
        await p.category.findMany({
          where: { isActive: true },
          select: { slug: true, updatedAt: true, seo: true },
          take: take(),
        })
      )
        .filter((x) => !noindex(x.seo))
        .map(({ slug, updatedAt }) => ({ slug, updatedAt }));
      budget -= categories.length;
      const collections = (
        await p.collection.findMany({
          where: { isActive: true },
          select: { slug: true, updatedAt: true, seo: true },
          take: take(),
        })
      )
        .filter((x) => !noindex(x.seo))
        .map(({ slug, updatedAt }) => ({ slug, updatedAt }));
      budget -= collections.length;
      const pages = (
        await p.page.findMany({
          where: { status: "PUBLISHED", OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
          select: { slug: true, updatedAt: true, seo: true },
          take: take(),
        })
      )
        .filter((x) => !noindex(x.seo))
        .map(({ slug, updatedAt }) => ({ slug, updatedAt }));
      budget -= pages.length;
      const features = (await getSettings(ctx)).features as { blog?: boolean } | null;
      const blog =
        features?.blog === false
          ? []
          : (
              await p.blogPost.findMany({
                where: {
                  status: "PUBLISHED",
                  OR: [{ publishAt: null }, { publishAt: { lte: now } }],
                },
                select: { slug: true, updatedAt: true, seo: true },
                orderBy: { updatedAt: "desc" },
                take: take(),
              })
            )
              .filter((x) => !noindex(x.seo))
              .map(({ slug, updatedAt }) => ({ slug, updatedAt }));
      res.set("Cache-Control", "public, max-age=300");
      res.json({ products: productsOut, categories, collections, pages, blog });
    }),
  );

  const abs = (d: SeoDefaults, path: string) =>
    d.siteUrl ? d.siteUrl.replace(/\/$/, "") + path : path;

  pub.get(
    "/seo/jsonld",
    h(async (req, res) => {
      const type = String(req.query.type ?? "").toLowerCase();
      const slug = typeof req.query.slug === "string" ? req.query.slug : "";
      const d = await getSeoDefaults(p);
      const settings = await getSettings(ctx);
      const pubSettings = publicSettings(settings);
      res.set("Cache-Control", "public, max-age=60");

      if (type === "organization") {
        const urls = await mediaUrlMap(ctx, [settings.logoMediaId]);
        const addr = (settings.address ?? {}) as Record<string, string>;
        return void res.json({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: settings.legalName || settings.name,
          url: d.siteUrl ?? undefined,
          logo: settings.logoMediaId ? urls.get(settings.logoMediaId) : undefined,
          email: settings.supportEmail ?? undefined,
          telephone: settings.phone ?? undefined,
          sameAs: Object.values((settings.social ?? {}) as Record<string, string>),
          address: addr.line1
            ? {
                "@type": "PostalAddress",
                streetAddress: [addr.line1, addr.line2].filter(Boolean).join(", "),
                addressLocality: addr.city,
                addressRegion: addr.state,
                postalCode: addr.postalCode,
                addressCountry: addr.country,
              }
            : undefined,
        });
      }

      if (type === "product") {
        const product = await p.product.findFirst({
          where: { slug, ...publishedWhere() },
          include: {
            variants: {
              where: { isActive: true },
              include: { inventory: true },
              orderBy: { position: "asc" },
            },
            images: { orderBy: { position: "asc" }, include: { media: true } },
          },
        });
        if (!product) throw AppError.notFound("Product");
        const agg = (await getRatingAggregates(p, [product.id])).get(product.id)!;
        const available = (v: (typeof product.variants)[number]) =>
          !v.inventory ||
          !v.inventory.trackInventory ||
          v.inventory.allowBackorder ||
          v.inventory.onHand - v.inventory.reserved > 0;
        const seo = resolveSeo(product.seo as EntitySeo | null, d, {
          title: product.title,
          description: product.shortDescription,
        });
        const offers = product.variants.map((v) => ({
          "@type": "Offer",
          sku: v.sku,
          price: v.price.toFixed(2),
          priceCurrency: settings.currency,
          availability: available(v)
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
          url: abs(d, `/product/${product.slug}`),
        }));
        return void res.json({
          "@context": "https://schema.org",
          "@type": "Product",
          name: product.title,
          description: seo.description || undefined,
          sku: product.variants[0]?.sku,
          brand: product.brand ? { "@type": "Brand", name: product.brand } : undefined,
          image: product.images.map((i) => ctx.providers.storage.url(i.media.storageKey)),
          url: abs(d, `/product/${product.slug}`),
          offers:
            offers.length > 1
              ? {
                  "@type": "AggregateOffer",
                  priceCurrency: settings.currency,
                  lowPrice: product.variants
                    .map((v) => Number(v.price))
                    .reduce((a, b) => Math.min(a, b))
                    .toFixed(2),
                  highPrice: product.variants
                    .map((v) => Number(v.price))
                    .reduce((a, b) => Math.max(a, b))
                    .toFixed(2),
                  offerCount: offers.length,
                  offers,
                }
              : offers[0],
          aggregateRating: agg.count
            ? { "@type": "AggregateRating", ratingValue: agg.average, reviewCount: agg.count }
            : undefined,
        });
      }

      if (type === "blogposting" || type === "blog" || type === "post") {
        const now = new Date();
        const post = await p.blogPost.findFirst({
          where: {
            slug,
            status: "PUBLISHED",
            OR: [{ publishAt: null }, { publishAt: { lte: now } }],
          },
        });
        if (!post) throw AppError.notFound("Post");
        const urls = await mediaUrlMap(ctx, [post.coverMediaId]);
        return void res.json({
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: post.title,
          description: post.excerpt ?? undefined,
          image: post.coverMediaId ? urls.get(post.coverMediaId) : undefined,
          author: post.authorName ? { "@type": "Person", name: post.authorName } : undefined,
          datePublished: (post.publishAt ?? post.createdAt).toISOString(),
          dateModified: post.updatedAt.toISOString(),
          keywords: post.tags.length ? post.tags.join(", ") : undefined,
          mainEntityOfPage: abs(d, `/blog/${post.slug}`),
          publisher: { "@type": "Organization", name: pubSettings.name },
        });
      }

      if (type === "category" || type === "breadcrumb" || type === "breadcrumblist") {
        const cats = await p.category.findMany({
          where: { isActive: true },
          select: { id: true, slug: true, name: true, parentId: true },
        });
        const byId = new Map(cats.map((c) => [c.id, c]));
        let cur = cats.find((c) => c.slug === slug);
        if (!cur) throw AppError.notFound("Category");
        const trail: typeof cats = [];
        while (cur && !trail.includes(cur)) {
          trail.unshift(cur);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return void res.json({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: abs(d, "/") },
            ...trail.map((c, i) => ({
              "@type": "ListItem",
              position: i + 2,
              name: c.name,
              item: abs(d, `/category/${c.slug}`),
            })),
          ],
        });
      }
      throw AppError.validation("Unsupported type", [
        { path: "type", message: "one of product, blogposting, organization, category" },
      ]);
    }),
  );

  /** Resolved SEO meta for a published page (title template etc.). */
  pub.get(
    "/seo/page/:slug",
    h(async (req, res) => {
      const page = await p.page.findUnique({ where: { slug: String(req.params.slug) } });
      if (!page || !isPublishedNow(page)) throw AppError.notFound("Page");
      const d = await getSeoDefaults(p);
      const r = resolveSeo(page.seo as EntitySeo | null, d, { title: page.title });
      const urls = await mediaUrlMap(ctx, [r.ogImageMediaId]);
      res.json({
        ...r,
        ogImageUrl: r.ogImageMediaId ? (urls.get(r.ogImageMediaId) ?? null) : null,
      });
    }),
  );

  const admin = Router();
  const w = requirePermission("seo.write");
  admin.get(
    "/seo",
    w,
    h(async (_req, res) => {
      res.json(await getSeoDefaults(p));
    }),
  );
  admin.put(
    "/seo",
    w,
    h(async (req, res) => {
      const body = parse(defaultsBody, req.body);
      if (body.defaultOgImageMediaId) {
        const m = await p.media.findUnique({
          where: { id: body.defaultOgImageMediaId },
          select: { id: true },
        });
        if (!m)
          throw AppError.validation("Unknown media", [
            { path: "defaultOgImageMediaId", message: "not found" },
          ]);
      }
      const before = await getSeoDefaults(p);
      const next = { ...before, ...body };
      await p.integrationSetting.upsert({
        where: { kind_provider: { kind: "SEO", provider: "DEFAULTS" } },
        create: { kind: "SEO", provider: "DEFAULTS", enabled: true, config: next },
        update: { config: next },
      });
      await audit(ctx, req, {
        action: "seo.update",
        entityType: "IntegrationSetting",
        entityId: "SEO:DEFAULTS",
        before,
        after: next,
      });
      res.json(next);
    }),
  );

  return { public: pub, admin };
}
