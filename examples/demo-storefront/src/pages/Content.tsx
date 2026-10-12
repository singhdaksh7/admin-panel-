import { Link, useParams, useSearchParams } from "react-router-dom";
import { serializeJsonLd } from "@kash-commerce/storefront-sdk";
import { useCommerce, useStore } from "../context/providers";
import { SectionRenderer } from "../components/Sections";
import { ErrorNote, Loading, Pagination } from "../components/ui";
import { isNotFound, useAsync, useTitle } from "../lib/util";
import NotFound from "./NotFound";

/** /pages/:slug — any CMS page, rendered generically from its sections. */
export function CmsPage() {
  const { slug = "" } = useParams();
  const commerce = useCommerce();
  const { settings } = useStore();
  const page = useAsync(() => commerce.pages.get(slug), [commerce, slug]);
  useTitle(page.data?.seo?.title || page.data?.title, settings?.name);
  if (page.loading) return <Loading />;
  if (page.error) return isNotFound(page.error) ? <NotFound /> : <ErrorNote error={page.error} />;
  if (!page.data) return null;
  return <SectionRenderer sections={page.data.sections} />;
}

export function BlogList() {
  const commerce = useCommerce();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const tag = params.get("tag") ?? undefined;
  const posts = useAsync(
    () => commerce.blog.list({ page, tag, pageSize: 9 }),
    [commerce, page, tag],
  );
  useTitle("Journal");
  if (posts.loading) return <Loading />;
  if (posts.error)
    return isNotFound(posts.error) ? <NotFound /> : <ErrorNote error={posts.error} />;
  return (
    <section>
      <h1>Journal</h1>
      {posts.data?.items.length === 0 ? <p>No posts yet.</p> : null}
      <ul className="grid plain">
        {posts.data?.items.map((p) => (
          <li key={p.id} className="card">
            {p.coverUrl ? <img src={p.coverUrl} alt="" loading="lazy" /> : null}
            <div className="card-body">
              <h2>
                <Link to={`/blog/${p.slug}`}>{p.title}</Link>
              </h2>
              <p className="muted">
                {new Date(p.publishedAt).toLocaleDateString()}
                {p.authorName ? ` · ${p.authorName}` : ""}
              </p>
              {p.excerpt ? <p>{p.excerpt}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {posts.data ? (
        <Pagination
          page={page}
          totalPages={posts.data.totalPages}
          onChange={(n) => {
            const next = new URLSearchParams(params);
            next.set("page", String(n));
            setParams(next);
          }}
        />
      ) : null}
    </section>
  );
}

export function BlogPostPage() {
  const { slug = "" } = useParams();
  const commerce = useCommerce();
  const { settings } = useStore();
  const post = useAsync(() => commerce.blog.getBySlug(slug), [commerce, slug]);
  const ld = useAsync(() => commerce.seo.jsonLd("blogposting", slug), [commerce, slug]);
  useTitle(post.data?.seo?.title || post.data?.title, settings?.name);
  if (post.loading) return <Loading />;
  if (post.error) return isNotFound(post.error) ? <NotFound /> : <ErrorNote error={post.error} />;
  const p = post.data;
  if (!p) return null;
  return (
    <article className="prose">
      {ld.data ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(ld.data) }}
        />
      ) : null}
      <p>
        <Link to="/blog">&larr; Journal</Link>
      </p>
      <h1>{p.title}</h1>
      <p className="muted">
        {new Date(p.publishedAt).toLocaleDateString()}
        {p.authorName ? ` · ${p.authorName}` : ""}
      </p>
      {p.coverUrl ? <img src={p.coverUrl} alt="" /> : null}
      {/* Post HTML is sanitised by the API on save. */}
      <div dangerouslySetInnerHTML={{ __html: p.body }} />
    </article>
  );
}
