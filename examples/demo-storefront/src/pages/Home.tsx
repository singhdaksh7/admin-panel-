import { Link } from "react-router-dom";
import { useCommerce, useStore } from "../context/providers";
import { SectionRenderer } from "../components/Sections";
import { ErrorNote, Loading, ProductCard } from "../components/ui";
import { isNotFound, useAsync, useTitle } from "../lib/util";

/** Renders the CMS page with slug "home"; falls back to featured products when there is none. */
export default function Home() {
  const commerce = useCommerce();
  const { settings } = useStore();
  const page = useAsync(() => commerce.pages.get("home"), [commerce]);
  const missing =
    (!!page.error && isNotFound(page.error)) || (!!page.data && page.data.sections.length === 0);
  const featured = useAsync(
    async () => (missing ? commerce.products.list({ sort: "featured", pageSize: 8 }) : null),
    [commerce, missing],
  );
  useTitle(page.data?.seo?.title || settings?.name);

  if (page.loading) return <Loading />;
  if (page.data && page.data.sections.length)
    return <SectionRenderer sections={page.data.sections} />;
  if (page.error && !missing) return <ErrorNote error={page.error} />;
  return (
    <section>
      <h1>{settings?.name ?? "Welcome"}</h1>
      {featured.loading ? <Loading /> : null}
      {featured.error ? <ErrorNote error={featured.error} /> : null}
      {featured.data ? (
        <>
          <h2>Featured products</h2>
          <div className="grid">
            {featured.data.items.map((p) => (
              <ProductCard key={p.id} product={{ ...p, imageUrl: p.image }} />
            ))}
          </div>
          <p>
            <Link to="/products">Browse all products</Link>
          </p>
        </>
      ) : null}
    </section>
  );
}
