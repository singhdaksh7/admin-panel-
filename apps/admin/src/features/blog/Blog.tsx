import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SearchBox,
  SelectField,
  Spinner,
  StatusBadge,
  TextArea,
  TextField,
  formatDate,
  useDebounced,
  useToast,
} from "../../components/ui";
import { MediaThumb } from "../../components/MediaPicker";
import {
  ImageField,
  SLUG_RE,
  fromLocalInput,
  handleSaveError,
  slugify,
  toLocalInput,
  type FieldErrors,
} from "../media/shared";
import { EMPTY_SEO, SeoFields, seoFromApi, seoToApi, type SeoState } from "../seo/SeoFields";

interface Post {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body?: string;
  coverMediaId: string | null;
  authorName: string | null;
  status: "DRAFT" | "PUBLISHED";
  publishAt: string | null;
  seo: Partial<SeoState> | null;
  tags: string[];
  updatedAt: string;
}

export function BlogList() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [toDelete, setToDelete] = useState<Post | null>(null);
  const q = useDebounced(search);
  const list = useQuery({
    queryKey: ["blog", q, status, page],
    queryFn: () => api.get<Paginated<Post>>("/blog", { q, status, page, pageSize: 20 }),
  });
  return (
    <>
      <PageHeader
        title="Blog"
        subtitle="Articles and announcements"
        actions={
          <Can perm="blog.write">
            <Link className="btn btn-primary" to="/blog/new">
              New post
            </Link>
          </Can>
        }
      />
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search posts"
        />
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="PUBLISHED">Published</option>
          <option value="DRAFT">Draft</option>
        </select>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.data!.items.length === 0 ? (
        <EmptyState title="No posts found" />
      ) : (
        <>
          <DataTable
            caption="Blog posts"
            rows={list.data!.items}
            rowKey={(p) => p.id}
            onRowClick={(p) => nav(`/blog/${p.id}`)}
            columns={[
              {
                key: "cover",
                header: "",
                width: "64px",
                render: (p) => <MediaThumb id={p.coverMediaId} size={40} />,
              },
              { key: "title", header: "Title", render: (p) => <strong>{p.title}</strong> },
              { key: "tags", header: "Tags", render: (p) => p.tags.join(", ") || "—" },
              { key: "status", header: "Status", render: (p) => <StatusBadge status={p.status} /> },
              { key: "updated", header: "Updated", render: (p) => formatDate(p.updatedAt) },
              {
                key: "actions",
                header: "",
                render: (p) =>
                  can("blog.write") ? (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button variant="danger" onClick={() => setToDelete(p)}>
                        Delete
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
          <Pagination
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            total={list.data!.total}
            onPage={setPage}
          />
        </>
      )}
      {toDelete && (
        <ConfirmDialog
          danger
          title="Delete post"
          message={`Delete "${toDelete.title}"?`}
          confirmLabel="Delete"
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            try {
              await api.delete(`/blog/${toDelete.id}`);
              toast.success("Post deleted");
              void qc.invalidateQueries({ queryKey: ["blog"] });
            } catch (e) {
              toast.error(e);
            }
            setToDelete(null);
          }}
        />
      )}
    </>
  );
}

export function BlogForm() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canWrite = can("blog.write");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [excerpt, setExcerpt] = useState("");
  const [body, setBody] = useState("");
  const [cover, setCover] = useState<string | null>(null);
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState<"DRAFT" | "PUBLISHED">("DRAFT");
  const [publishAt, setPublishAt] = useState("");
  const [seo, setSeo] = useState<SeoState>(EMPTY_SEO);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["blog-post", id],
    queryFn: () => api.get<Post>(`/blog/${id}`),
    enabled: !isNew,
  });
  useEffect(() => {
    const p = q.data;
    if (!p) return;
    setTitle(p.title);
    setSlug(p.slug);
    setSlugTouched(true);
    setExcerpt(p.excerpt ?? "");
    setBody(p.body ?? "");
    setCover(p.coverMediaId);
    setAuthor(p.authorName ?? "");
    setTags(p.tags.join(", "));
    setStatus(p.status);
    setPublishAt(toLocalInput(p.publishAt));
    setSeo(seoFromApi(p.seo));
  }, [q.data]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: FieldErrors = {};
    if (!title.trim()) errs.title = "Title is required";
    if (slug && !SLUG_RE.test(slug)) errs.slug = "Lowercase letters, digits and hyphens only";
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tagList.length > 20) errs.tags = "At most 20 tags";
    if (tagList.some((t) => t.length > 40)) errs.tags = "Tags are at most 40 characters";
    if (status === "PUBLISHED" && !body.trim()) errs.body = "Write some content before publishing";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const payload = {
        title: title.trim(),
        ...(slug ? { slug } : {}),
        excerpt: excerpt.trim() || null,
        body,
        coverMediaId: cover,
        authorName: author.trim() || null,
        status,
        publishAt: fromLocalInput(publishAt),
        seo: seoToApi(seo),
        tags: tagList,
      };
      if (isNew) await api.post("/blog", payload);
      else await api.patch(`/blog/${id}`, payload);
      toast.success(isNew ? "Post created" : "Post saved");
      void qc.invalidateQueries({ queryKey: ["blog"] });
      void qc.invalidateQueries({ queryKey: ["blog-post", id] });
      nav("/blog");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setErrors({ slug: err.message });
      else handleSaveError(err, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }

  if (!isNew && q.isLoading) return <Spinner />;
  if (!isNew && q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;

  return (
    <>
      <PageHeader
        title={isNew ? "New post" : title || "Post"}
        actions={<Link to="/blog">Back to blog</Link>}
      />
      <form onSubmit={submit} noValidate className="g-stack">
        <fieldset disabled={!canWrite} style={{ border: 0, padding: 0, margin: 0 }}>
          <Card title="Content">
            <div className="g-stack">
              <TextField
                label="Title"
                value={title}
                maxLength={200}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (isNew && !slugTouched) setSlug(slugify(e.target.value));
                }}
                error={errors.title}
              />
              <TextField
                label="Slug"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugTouched(true);
                }}
                error={errors.slug}
              />
              <TextArea
                label="Excerpt"
                rows={3}
                maxLength={500}
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                error={errors.excerpt}
              />
              <TextArea
                label="Body (HTML)"
                rows={14}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                error={errors.body}
                hint="HTML is sanitized by the server"
              />
              <ImageField
                label="Cover image"
                value={cover}
                onChange={setCover}
                error={errors.coverMediaId}
              />
            </div>
          </Card>
          <Card title="Publishing">
            <div className="form-grid">
              <TextField
                label="Author"
                maxLength={120}
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                error={errors.authorName}
              />
              <TextField
                label="Tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                hint="Comma separated"
                error={errors.tags}
              />
              <SelectField
                label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value as "DRAFT" | "PUBLISHED")}
                options={[
                  { value: "DRAFT", label: "Draft" },
                  { value: "PUBLISHED", label: "Published" },
                ]}
              />
              <TextField
                label="Publish at"
                type="datetime-local"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
                error={errors.publishAt}
                hint="Optional - schedule for later"
              />
            </div>
          </Card>
          <Card title="SEO">
            <SeoFields value={seo} onChange={setSeo} errors={errors} />
          </Card>
        </fieldset>
        {canWrite && (
          <div className="g-actions">
            <Button variant="primary" type="submit" loading={busy}>
              {isNew ? "Create post" : "Save post"}
            </Button>
            <Button type="button" onClick={() => nav("/blog")}>
              Cancel
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
