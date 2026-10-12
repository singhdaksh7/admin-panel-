import { useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import type { NavigationItem } from "@kash-commerce/storefront-sdk";
import { useAuth, useCart, useStore } from "../context/providers";
import { SmartLink } from "./ui";

function NavEntry({ item }: { item: NavigationItem }) {
  const [open, setOpen] = useState(false);
  const hasChildren = item.children.length > 0;
  return (
    <li
      className={`nav-item${open ? " open" : ""}`}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      {item.url ? (
        <SmartLink to={item.url} newTab={item.openInNewTab}>
          {item.label}
        </SmartLink>
      ) : (
        <span>{item.label}</span>
      )}
      {item.badge ? <span className="badge">{item.badge}</span> : null}
      {hasChildren ? (
        <>
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={open}
            aria-label={`${item.label} submenu`}
            onClick={() => setOpen((o) => !o)}
          >
            ▾
          </button>
          <div className="dropdown">
            <ul>
              {item.children.map((c) => (
                <li key={c.id}>
                  {c.url ? (
                    <SmartLink to={c.url} newTab={c.openInNewTab}>
                      {c.label}
                    </SmartLink>
                  ) : (
                    <span>{c.label}</span>
                  )}
                  {c.children.length > 0 ? (
                    <ul className="sub">
                      {c.children.map((g) => (
                        <li key={g.id}>
                          {g.url ? <SmartLink to={g.url}>{g.label}</SmartLink> : g.label}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            {item.promo?.url ? (
              <SmartLink to={item.promo.url} className="promo">
                {item.promo.mediaUrl ? <img src={item.promo.mediaUrl} alt="" /> : null}
                <strong>{item.promo.title}</strong>
                <span>{item.promo.subtitle}</span>
              </SmartLink>
            ) : null}
          </div>
        </>
      ) : null}
    </li>
  );
}

export function Layout() {
  const { settings, nav, footer } = useStore();
  const { cart } = useCart();
  const { customer } = useAuth();
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const name = settings?.name ?? "Store";
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container header-row">
          <Link to="/" className="brand">
            {name}
          </Link>
          <nav aria-label="Main">
            <ul className="nav">
              {(nav?.items ?? [])
                .filter((i) => i.showDesktop)
                .map((i) => (
                  <NavEntry key={i.id} item={i} />
                ))}
            </ul>
          </nav>
          <form
            role="search"
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) navigate(`/search?q=${encodeURIComponent(search.trim())}`);
            }}
          >
            <label className="sr-only" htmlFor="site-search">
              Search products
            </label>
            <input
              id="site-search"
              type="search"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
          <div className="header-actions">
            <Link to="/account">{customer ? "Account" : "Sign in"}</Link>
            <Link to="/cart" aria-label={`Cart, ${cart?.itemCount ?? 0} items`}>
              Cart ({cart?.itemCount ?? 0})
            </Link>
          </div>
        </div>
      </header>
      <main id="main" className="container main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container">
          <nav aria-label="Footer">
            <ul className="footer-links">
              {(footer?.items ?? []).map((i) => (
                <li key={i.id}>{i.url ? <SmartLink to={i.url}>{i.label}</SmartLink> : i.label}</li>
              ))}
              <li>
                <Link to="/blog">Journal</Link>
              </li>
            </ul>
          </nav>
          <p className="muted">
            &copy; {new Date().getFullYear()} {name}. Demo storefront built on the Kash Commerce
            SDK.
          </p>
        </div>
      </footer>
    </>
  );
}
