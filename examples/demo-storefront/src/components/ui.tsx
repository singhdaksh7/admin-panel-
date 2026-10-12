import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatMoney } from "@kash-commerce/storefront-sdk";
import { useStore } from "../context/providers";
import { errorMessage } from "../lib/util";

/** Internal paths use the router; absolute / mailto / tel links are plain anchors. */
export function SmartLink({
  to,
  children,
  className,
  newTab,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  newTab?: boolean;
}) {
  if (/^(https?:|mailto:|tel:|#)/i.test(to) || newTab)
    return (
      <a
        href={to}
        className={className}
        {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}

export function Money({ amount, currency }: { amount: string | null; currency?: string }) {
  const { settings } = useStore();
  if (amount === null) return null;
  return <>{formatMoney(amount, currency ?? settings?.currency ?? "USD", settings?.locale)}</>;
}

export function Price({
  price,
  compareAt,
  currency,
}: {
  price: string | null;
  compareAt?: string | null;
  currency?: string;
}) {
  if (price === null) return <span className="muted">Unavailable</span>;
  return (
    <span className="price">
      <strong>
        <Money amount={price} currency={currency} />
      </strong>
      {compareAt ? (
        <>
          {" "}
          <s className="muted" aria-label="Original price">
            <Money amount={compareAt} currency={currency} />
          </s>
        </>
      ) : null}
    </span>
  );
}

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <p role="status" className="muted">
      {label}
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p role="alert" className="notice error">
      {errorMessage(error)}
    </p>
  );
}

export interface CardProduct {
  slug: string;
  title: string;
  price: string | null;
  compareAtPrice: string | null;
  imageUrl: string | null;
  isNew?: boolean;
  inStock?: boolean;
  rating?: { average: number; count: number };
  currency?: string;
}

export function ProductCard({ product }: { product: CardProduct }) {
  return (
    <article className="card">
      <Link to={`/product/${product.slug}`} className="card-media" tabIndex={-1} aria-hidden="true">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" loading="lazy" />
        ) : (
          <span className="placeholder">No image</span>
        )}
      </Link>
      <div className="card-body">
        <h3>
          <Link to={`/product/${product.slug}`}>{product.title}</Link>
        </h3>
        <Price
          price={product.price}
          compareAt={product.compareAtPrice}
          currency={product.currency}
        />
        <div className="badges">
          {product.isNew ? <span className="badge">New</span> : null}
          {product.inStock === false ? <span className="badge muted-badge">Sold out</span> : null}
          {product.rating && product.rating.count > 0 ? (
            <span className="muted" aria-label={`Rated ${product.rating.average} out of 5`}>
              ★ {product.rating.average} ({product.rating.count})
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange(page: number): void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span aria-live="polite">
        Page {page} of {totalPages}
      </span>
      <button type="button" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        Next
      </button>
    </nav>
  );
}
