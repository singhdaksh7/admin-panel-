import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  serializeJsonLd,
  type ProductDetail as Product,
  type ProductVariant,
} from "@kash-commerce/storefront-sdk";
import { useCart, useCommerce, useStore } from "../context/providers";
import { ErrorNote, Loading, Price, ProductCard } from "../components/ui";
import { errorMessage, isNotFound, useAsync, useTitle } from "../lib/util";
import NotFound from "./NotFound";

type Selection = Record<string, string>;

const matches = (v: ProductVariant, sel: Selection) =>
  Object.entries(sel).every(([attr, val]) =>
    v.attributes.some((a) => a.attributeSlug === attr && a.valueSlug === val),
  );

function initialSelection(p: Product): Selection {
  const v =
    p.variants.find((x) => x.isDefault && x.inStock) ??
    p.variants.find((x) => x.inStock) ??
    p.variants[0];
  const sel: Selection = {};
  for (const a of v?.attributes ?? []) sel[a.attributeSlug] = a.valueSlug;
  return sel;
}

export default function ProductDetail() {
  const { slug = "" } = useParams();
  const commerce = useCommerce();
  const { settings } = useStore();
  const product = useAsync(() => commerce.products.getBySlug(slug), [commerce, slug]);
  useTitle(product.data?.seo?.title || product.data?.title, settings?.name);

  if (product.loading) return <Loading />;
  if (product.error)
    return isNotFound(product.error) ? <NotFound /> : <ErrorNote error={product.error} />;
  if (!product.data) return null;
  return <ProductView key={product.data.id} product={product.data} />;
}

function ProductView({ product }: { product: Product }) {
  const commerce = useCommerce();
  const cart = useCart();
  const [sel, setSel] = useState<Selection>(() => initialSelection(product));
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);

  const variant = useMemo(
    () =>
      product.variants.find((v) => matches(v, sel)) ??
      (product.options.length ? undefined : product.variants[0]),
    [product, sel],
  );
  const images = product.images.length ? product.images : [];
  const mainImage = variant?.image ?? images[imageIndex]?.url ?? product.image;

  // A value is selectable when some variant with the other current selections + this value is in stock.
  const valueAvailable = (attr: string, val: string) =>
    product.variants.some((v) => v.inStock && matches(v, { ...sel, [attr]: val }));

  const ld = useAsync(() => commerce.seo.jsonLd("product", product.slug), [commerce, product.slug]);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!variant) return;
    setAdded(false);
    setAdded(await cart.add(variant.id, qty));
  }

  return (
    <article className="product">
      {ld.data ? (
        <script
          type="application/ld+json"
          // serializeJsonLd escapes "<", ">" and "&" so the payload cannot close the tag
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(ld.data) }}
        />
      ) : null}
      <nav aria-label="Breadcrumb" className="muted">
        <Link to="/products">Shop</Link>
        {product.category ? (
          <>
            {" / "}
            <Link to={`/category/${product.category.slug}`}>{product.category.name}</Link>
          </>
        ) : null}
      </nav>
      <div className="product-layout">
        <div className="gallery">
          <div className="gallery-main">
            {mainImage ? (
              <img src={mainImage} alt={images[imageIndex]?.alt ?? product.title} />
            ) : (
              <span className="placeholder">No image</span>
            )}
          </div>
          {images.length > 1 ? (
            <ul className="thumbs" aria-label="Product images">
              {images.map((img, i) => (
                <li key={img.url}>
                  <button
                    type="button"
                    aria-label={`Show image ${i + 1}`}
                    aria-pressed={i === imageIndex}
                    onClick={() => setImageIndex(i)}
                  >
                    <img src={img.url} alt="" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div>
          <h1>{product.title}</h1>
          {product.brand ? <p className="muted">{product.brand}</p> : null}
          {product.rating.count > 0 ? (
            <p
              aria-label={`Rated ${product.rating.average} out of 5 from ${product.rating.count} reviews`}
            >
              ★ {product.rating.average} ({product.rating.count})
            </p>
          ) : null}
          <p className="big-price">
            <Price
              price={variant?.price ?? product.price}
              compareAt={variant ? variant.compareAtPrice : product.compareAtPrice}
              currency={product.currency}
            />
          </p>
          {product.shortDescription ? <p>{product.shortDescription}</p> : null}

          <form onSubmit={onAdd} aria-label="Add to cart">
            {product.options.map((o) => (
              <fieldset key={o.attributeSlug} className="option">
                <legend>{o.attribute}</legend>
                <div className="option-values">
                  {o.values.map((val) => {
                    const id = `opt-${o.attributeSlug}-${val.slug}`;
                    const available = valueAvailable(o.attributeSlug, val.slug);
                    return (
                      <span key={val.slug}>
                        <input
                          type="radio"
                          id={id}
                          name={o.attributeSlug}
                          className="sr-only"
                          checked={sel[o.attributeSlug] === val.slug}
                          onChange={() => setSel((s) => ({ ...s, [o.attributeSlug]: val.slug }))}
                        />
                        <label htmlFor={id} className={`pill${available ? "" : " unavailable"}`}>
                          {val.value}
                        </label>
                      </span>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <p role="status">
              {!variant
                ? "This combination is not available."
                : variant.inStock
                  ? variant.available <= 5
                    ? `Only ${variant.available} left`
                    : "In stock"
                  : "Out of stock"}
            </p>
            <label>
              Quantity{" "}
              <input
                type="number"
                min={1}
                max={Math.max(1, variant?.available ?? 1)}
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>{" "}
            <button type="submit" disabled={!variant || !variant.inStock || cart.busy}>
              Add to cart
            </button>
            {added ? (
              <p role="status" className="notice ok">
                Added to cart. <Link to="/cart">View cart</Link>
              </p>
            ) : null}
            {cart.error ? (
              <p role="alert" className="notice error">
                {cart.error}
              </p>
            ) : null}
          </form>

          {product.description ? <p className="description">{product.description}</p> : null}
          {product.tags.length ? (
            <p className="muted">Tags: {product.tags.map((t) => t.name).join(", ")}</p>
          ) : null}
        </div>
      </div>

      <Reviews slug={product.slug} />

      {product.related.length ? (
        <section className="section">
          <h2>You may also like</h2>
          <div className="grid">
            {product.related.slice(0, 4).map((p) => (
              <ProductCard key={p.id} product={{ ...p, imageUrl: p.image }} />
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

function Reviews({ slug }: { slug: string }) {
  const commerce = useCommerce();
  const { settings } = useStore();
  const reviews = useAsync(() => commerce.reviews.list(slug, { pageSize: 10 }), [commerce, slug]);
  const [form, setForm] = useState({ rating: 5, title: "", body: "", authorName: "", email: "" });
  const [state, setState] = useState<{ message?: string; error?: string; sending?: boolean }>({});

  useEffect(() => setState({}), [slug]);
  if (settings && !settings.features.reviews) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState({ sending: true });
    try {
      const r = await commerce.reviews.create(slug, {
        rating: form.rating,
        title: form.title || undefined,
        body: form.body,
        authorName: form.authorName,
        email: form.email,
      });
      setState({
        message:
          r.status === "PENDING"
            ? "Thanks! Your review is pending moderation and will appear once approved."
            : r.message,
      });
      setForm({ rating: 5, title: "", body: "", authorName: "", email: "" });
    } catch (err) {
      setState({ error: errorMessage(err) });
    }
  }
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <section className="section" aria-labelledby="reviews-h">
      <h2 id="reviews-h">Reviews</h2>
      {reviews.loading ? <Loading /> : null}
      {reviews.data ? (
        reviews.data.items.length ? (
          <ul className="reviews">
            {reviews.data.items.map((r) => (
              <li key={r.id}>
                <span aria-label={`${r.rating} out of 5`}>{"★".repeat(r.rating)}</span>{" "}
                <strong>{r.title}</strong>
                {r.verifiedPurchase ? <span className="badge">Verified purchase</span> : null}
                <p>{r.body}</p>
                <small className="muted">{r.authorName}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No reviews yet.</p>
        )
      ) : null}

      <form onSubmit={submit} className="stack" aria-label="Write a review">
        <h3>Write a review</h3>
        <label>
          Rating
          <select value={form.rating} onChange={(e) => set("rating", Number(e.target.value))}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} star{n > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Your name
          <input
            required
            value={form.authorName}
            onChange={(e) => set("authorName", e.target.value)}
          />
        </label>
        <label>
          Email (not shown)
          <input
            required
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </label>
        <label>
          Title
          <input value={form.title} onChange={(e) => set("title", e.target.value)} />
        </label>
        <label>
          Review
          <textarea
            required
            rows={4}
            value={form.body}
            onChange={(e) => set("body", e.target.value)}
          />
        </label>
        <button type="submit" disabled={state.sending}>
          Submit review
        </button>
        {state.message ? (
          <p role="status" className="notice ok">
            {state.message}
          </p>
        ) : null}
        {state.error ? (
          <p role="alert" className="notice error">
            {state.error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
