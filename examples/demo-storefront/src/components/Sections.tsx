import { Link } from "react-router-dom";
import type {
  BlogCard,
  Cta,
  PageSection,
  ProductCard as ProductCardData,
  Responsive,
  ReviewCard,
} from "@kash-commerce/storefront-sdk";
import { ProductCard, SmartLink } from "./ui";

/**
 * Generic CMS renderer. Contract: each section is `{ id, type, content }`; `type` selects the
 * component, unknown types fall back to a JSON dump so new section types never break a page.
 * Media fields arrive as `<name>MediaId` + a resolved `<name>Url` next to it.
 *
 * HTML fields (`RICH_TEXT.html`, `TEXT.body`) are sanitised by the API before they are stored,
 * so they are rendered with dangerouslySetInnerHTML. If you do not trust your editors, sanitise again.
 */
export function SectionRenderer({ sections }: { sections: PageSection[] }) {
  return (
    <>
      {sections.map((s) => (
        <Section key={s.id} section={s} />
      ))}
    </>
  );
}

function Picture({ image, className }: { image?: Responsive; className?: string }) {
  if (!image?.desktopMediaUrl) return null;
  return (
    <picture>
      {image.mobileMediaUrl ? (
        <source media="(max-width: 700px)" srcSet={image.mobileMediaUrl} />
      ) : null}
      <img className={className} src={image.desktopMediaUrl} alt={image.alt ?? ""} />
    </picture>
  );
}

function CtaLink({ cta, secondary }: { cta?: Cta; secondary?: boolean }) {
  if (!cta) return null;
  return (
    <SmartLink to={cta.url} className={secondary ? "button secondary" : "button"}>
      {cta.label}
    </SmartLink>
  );
}

const cardOf = (p: ProductCardData) => ({
  slug: p.slug,
  title: p.title,
  price: p.price,
  compareAtPrice: p.compareAtPrice,
  imageUrl: p.imageUrl,
  isNew: p.isNew,
  rating: p.rating,
});

export function Section({ section }: { section: PageSection }) {
  switch (section.type) {
    case "HERO": {
      const c = section.content;
      return (
        <section className={`hero align-${c.align}`} aria-label={c.heading}>
          <Picture image={c.image} className="hero-img" />
          <div className="hero-copy">
            <h1>{c.heading}</h1>
            {c.subheading ? <p>{c.subheading}</p> : null}
            <p className="actions">
              <CtaLink cta={c.cta} />
              <CtaLink cta={c.secondaryCta} secondary />
            </p>
          </div>
        </section>
      );
    }
    case "PROMO_BANNER": {
      const c = section.content;
      return (
        <aside
          className="promo-banner"
          style={{ background: c.backgroundColor, color: c.textColor }}
        >
          <Picture image={c.image} />
          <span>{c.text}</span>
          {c.cta ? (
            <SmartLink to={c.cta.url} className="promo-link">
              {c.cta.label}
            </SmartLink>
          ) : null}
        </aside>
      );
    }
    case "PRODUCT_GRID": {
      const c = section.content;
      if (!c.items?.length) return null;
      return (
        <section className="section">
          {c.heading ? <h2>{c.heading}</h2> : null}
          <div className="grid">
            {c.items.map((p) => (
              <ProductCard key={p.id} product={cardOf(p)} />
            ))}
          </div>
          {c.cta ? <CtaLink cta={c.cta} secondary /> : null}
        </section>
      );
    }
    case "CATEGORY_GRID": {
      const c = section.content;
      if (!c.items?.length) return null;
      return (
        <section className="section">
          {c.heading ? <h2>{c.heading}</h2> : null}
          <ul className="grid category-grid">
            {c.items.map((cat) => (
              <li key={cat.id} className="card">
                <Link to={cat.url} className="card-body">
                  {cat.imageUrl ? <img src={cat.imageUrl} alt="" loading="lazy" /> : null}
                  <strong>{cat.name}</strong>
                  {cat.description ? <span className="muted">{cat.description}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      );
    }
    case "RICH_TEXT":
      return (
        <section
          className="section prose"
          dangerouslySetInnerHTML={{ __html: section.content.html }}
        />
      );
    case "TEXT": {
      const c = section.content;
      return (
        <section className={`section prose align-${c.align}`}>
          {c.heading ? <h2>{c.heading}</h2> : null}
          <div dangerouslySetInnerHTML={{ __html: c.body }} />
        </section>
      );
    }
    case "IMAGE": {
      const c = section.content;
      const img = <Picture image={c.image} />;
      return (
        <figure className="section image-section">
          {c.linkUrl ? <SmartLink to={c.linkUrl}>{img}</SmartLink> : img}
          {c.caption ? <figcaption className="muted">{c.caption}</figcaption> : null}
        </figure>
      );
    }
    case "REVIEWS": {
      const c = section.content;
      if (!c.items?.length) return null;
      return (
        <section className="section">
          {c.heading ? <h2>{c.heading}</h2> : null}
          <ul className="reviews">
            {c.items.map((r: ReviewCard) => (
              <li key={r.id}>
                <span aria-label={`${r.rating} out of 5`}>{"★".repeat(r.rating)}</span>{" "}
                <strong>{r.title}</strong>
                <p>{r.body}</p>
                <small className="muted">
                  {r.authorName}
                  {r.product ? (
                    <>
                      {" "}
                      on <Link to={`/product/${r.product.slug}`}>{r.product.title}</Link>
                    </>
                  ) : null}
                </small>
              </li>
            ))}
          </ul>
        </section>
      );
    }
    case "BLOG_PREVIEW": {
      const c = section.content;
      if (!c.items?.length) return null;
      return (
        <section className="section">
          {c.heading ? <h2>{c.heading}</h2> : null}
          <ul className="grid">
            {c.items.map((p: BlogCard) => (
              <li key={p.id} className="card">
                <div className="card-body">
                  <h3>
                    <Link to={`/blog/${p.slug}`}>{p.title}</Link>
                  </h3>
                  {p.excerpt ? <p className="muted">{p.excerpt}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      );
    }
    case "CUSTOM_JSON":
    default:
      return <JsonFallback section={section} />;
  }
}

function JsonFallback({ section }: { section: { type: string; content: unknown } }) {
  return (
    <section className="section" data-section-type={section.type}>
      <details>
        <summary>Custom section: {section.type}</summary>
        <pre>{JSON.stringify(section.content, null, 2)}</pre>
      </details>
    </section>
  );
}
