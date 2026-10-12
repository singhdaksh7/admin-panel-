import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { parseProductQuery, type ProductQuery } from "@kash-commerce/storefront-sdk";
import { useCommerce } from "../context/providers";
import { applyFilterChange, Filters, type FilterChange } from "../components/Filters";
import { ErrorNote, Loading, Pagination, ProductCard } from "../components/ui";
import { isNotFound, useAsync, useTitle } from "../lib/util";
import NotFound from "./NotFound";

const SORTS: Array<[string, string]> = [
  ["newest", "Newest"],
  ["featured", "Featured"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["title", "Name"],
];
const PAGE_SIZE = 12;

/** /products, /category/:slug, /collection/:slug and /search?q= share this listing. */
export default function Listing({ mode }: { mode: "all" | "category" | "collection" | "search" }) {
  const commerce = useCommerce();
  const navigate = useNavigate();
  const { slug } = useParams();
  const [search, setSearch] = useSearchParams();

  const query: ProductQuery = parseProductQuery(search);
  const category = mode === "category" ? slug : query.category;
  if (mode === "collection") query.collection = slug;
  const page = query.page ?? 1;

  const info = useAsync(
    async () => (mode === "category" && slug ? commerce.categories.get(slug) : null),
    [commerce, mode, slug],
  );
  const list = useAsync(
    () =>
      commerce.products.list({
        ...query,
        category,
        pageSize: PAGE_SIZE,
        sort: query.sort ?? "newest",
      }),
    [commerce, mode, slug, search.toString()],
  );
  const { page: _p, pageSize: _ps, sort: _s, category: _c, ...selections } = query;
  void [_p, _ps, _s, _c];
  const filters = useAsync(
    () => commerce.filters.get({ category, selections }),
    [commerce, mode, slug, search.toString()],
  );

  const heading =
    mode === "search"
      ? `Search results for "${query.q ?? ""}"`
      : (info.data?.name ?? (mode === "collection" ? (slug ?? "Collection") : "All products"));
  useTitle(heading);

  if (info.error && isNotFound(info.error)) return <NotFound />;

  const onFilter = (c: FilterChange) => {
    const { params, categorySlug } = applyFilterChange(search, c);
    if (categorySlug !== undefined) {
      const qs = params.toString();
      navigate(`${categorySlug ? `/category/${categorySlug}` : "/products"}${qs ? `?${qs}` : ""}`);
    } else setSearch(params);
  };
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setSearch(next);
  };

  return (
    <div>
      <h1>{heading}</h1>
      {info.data?.description ? <p className="muted">{info.data.description}</p> : null}
      {info.data && info.data.children.length > 0 ? (
        <ul className="chips" aria-label="Subcategories">
          {info.data.children.map((c) => (
            <li key={c.id}>
              <Link to={`/category/${c.slug}`}>{c.name}</Link>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="listing">
        <div>
          {filters.error ? (
            <ErrorNote error={filters.error} />
          ) : (
            <Filters
              groups={filters.data?.groups ?? []}
              minPrice={query.minPrice?.toString() ?? ""}
              maxPrice={query.maxPrice?.toString() ?? ""}
              onChange={onFilter}
            />
          )}
        </div>
        <section aria-live="polite">
          <div className="toolbar">
            <span className="muted">
              {list.data ? `${list.data.total} product${list.data.total === 1 ? "" : "s"}` : ""}
            </span>
            <label>
              Sort by{" "}
              <select
                value={query.sort ?? "newest"}
                onChange={(e) => setParam("sort", e.target.value)}
              >
                {SORTS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {list.loading ? <Loading /> : null}
          {list.error ? <ErrorNote error={list.error} /> : null}
          {list.data && list.data.items.length === 0 ? (
            <p>No products match these filters.</p>
          ) : null}
          <div className="grid">
            {list.data?.items.map((p) => (
              <ProductCard key={p.id} product={{ ...p, imageUrl: p.image }} />
            ))}
          </div>
          {list.data ? (
            <Pagination
              page={page}
              totalPages={list.data.totalPages}
              onChange={(n) => setParam("page", n > 1 ? String(n) : null)}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
