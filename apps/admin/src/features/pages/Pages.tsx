import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  SearchBox,
  SelectField,
  Spinner,
  StatusBadge,
  TextField,
  CheckField,
  formatDate,
  useDebounced,
  useToast,
} from "../../components/ui";
import {
  fromLocalInput,
  handleSaveError,
  slugify,
  SLUG_RE,
  toLocalInput,
  type FieldErrors,
} from "../media/shared";
import { EMPTY_SEO, SeoFields, seoFromApi, seoToApi, type SeoState } from "../seo/SeoFields";
import {
  SECTION_SPECS,
  SPEC_BY_TYPE,
  SectionContentForm,
  cleanContent,
  summarize,
  validateContent,
  type Content,
  type SectionType,
} from "./sections";
import "./pages.css";

interface PageRow {
  id: string;
  slug: string;
  title: string;
  status: "DRAFT" | "PUBLISHED";
  publishAt: string | null;
  updatedAt: string;
  _count?: { sections: number };
}
export interface Section {
  id: string;
  type: string;
  key: string | null;
  content: Content;
  sortOrder: number;
  isEnabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}
interface PageFull extends PageRow {
  seo: Partial<SeoState> | null;
  sections: Section[];
}

/* ───────── List ───────── */

export function PagesList() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [toDelete, setToDelete] = useState<PageRow | null>(null);
  const q = useDebounced(search);
  const list = useQuery({
    queryKey: ["pages", q, status, page],
    queryFn: () => api.get<Paginated<PageRow>>("/pages", { q, status, page, pageSize: 20 }),
  });
  return (
    <>
      <PageHeader
        title="Pages"
        subtitle="Build storefront pages from sections"
        actions={
          <Can perm="content.write">
            <Link className="btn btn-primary" to="/pages/new">
              New page
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
          placeholder="Search pages"
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
        <EmptyState title="No pages yet" />
      ) : (
        <>
          <DataTable
            caption="Pages"
            rows={list.data!.items}
            rowKey={(p) => p.id}
            onRowClick={(p) => nav(`/pages/${p.id}`)}
            columns={[
              { key: "title", header: "Title", render: (p) => <strong>{p.title}</strong> },
              { key: "slug", header: "Slug", render: (p) => `/${p.slug}` },
              { key: "status", header: "Status", render: (p) => <StatusBadge status={p.status} /> },
              { key: "sections", header: "Sections", render: (p) => p._count?.sections ?? 0 },
              { key: "updated", header: "Updated", render: (p) => formatDate(p.updatedAt) },
              {
                key: "actions",
                header: "",
                render: (p) =>
                  can("content.write") ? (
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
          title="Delete page"
          message={`Delete "${toDelete.title}" and all of its sections?`}
          confirmLabel="Delete"
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            try {
              await api.delete(`/pages/${toDelete.id}`);
              toast.success("Page deleted");
              void qc.invalidateQueries({ queryKey: ["pages"] });
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

/* ───────── Editor ───────── */

export function PageEditor() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canWrite = can("content.write");

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [status, setStatus] = useState<"DRAFT" | "PUBLISHED">("DRAFT");
  const [publishAt, setPublishAt] = useState("");
  const [seo, setSeo] = useState<SeoState>(EMPTY_SEO);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["page", id],
    queryFn: () => api.get<PageFull>(`/pages/${id}`),
    enabled: !isNew,
  });
  useEffect(() => {
    const p = q.data;
    if (!p) return;
    setTitle(p.title);
    setSlug(p.slug);
    setSlugTouched(true);
    setStatus(p.status);
    setPublishAt(toLocalInput(p.publishAt));
    setSeo(seoFromApi(p.seo));
  }, [q.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const errs: FieldErrors = {};
    if (!title.trim()) errs.title = "Title is required";
    if (slug && !SLUG_RE.test(slug)) errs.slug = "Lowercase letters, digits and hyphens only";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const body = {
        title: title.trim(),
        ...(slug ? { slug } : {}),
        status,
        publishAt: fromLocalInput(publishAt),
        seo: seoToApi(seo),
      };
      if (isNew) {
        const created = await api.post<PageRow>("/pages", body);
        toast.success("Page created. Add sections below.");
        void qc.invalidateQueries({ queryKey: ["pages"] });
        nav(`/pages/${created.id}`, { replace: true });
      } else {
        await api.patch(`/pages/${id}`, body);
        toast.success("Page saved");
        void qc.invalidateQueries({ queryKey: ["pages"] });
        void qc.invalidateQueries({ queryKey: ["page", id] });
      }
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
        title={isNew ? "New page" : title || "Page"}
        actions={<Link to="/pages">Back to pages</Link>}
      />
      <form onSubmit={save} noValidate className="g-stack">
        <fieldset disabled={!canWrite} style={{ border: 0, padding: 0, margin: 0 }}>
          <Card title="Page details">
            <div className="form-grid">
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
                hint="Used in the page URL"
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
                hint="Optional - hidden until this time"
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
              {isNew ? "Create page" : "Save page"}
            </Button>
          </div>
        )}
      </form>
      {!isNew && q.data && (
        <SectionsPanel pageId={q.data.id} sections={q.data.sections} canWrite={canWrite} />
      )}
    </>
  );
}

/* ───────── Sections ───────── */

function SectionsPanel({
  pageId,
  sections,
  canWrite,
}: {
  pageId: string;
  sections: Section[];
  canWrite: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<SectionType | "">("");
  const [editor, setEditor] = useState<{ type: SectionType; section?: Section } | null>(null);
  const [toDelete, setToDelete] = useState<Section | null>(null);
  const types = useQuery({
    queryKey: ["section-types"],
    queryFn: () => api.get<{ types: string[] }>("/content/section-types"),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const known = SECTION_SPECS.filter((s) => !types.data || types.data.types.includes(s.type));
  const refresh = () => void qc.invalidateQueries({ queryKey: ["page", pageId] });

  async function move(index: number, dir: -1 | 1) {
    const ids = sections.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    try {
      await api.put(`/pages/${pageId}/sections/reorder`, { ids });
      refresh();
    } catch (e) {
      toast.error(e);
    }
  }
  async function toggle(s: Section) {
    try {
      await api.patch(`/pages/${pageId}/sections/${s.id}`, { isEnabled: !s.isEnabled });
      refresh();
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <Card title={`Sections (${sections.length})`}>
      {canWrite && (
        <div className="toolbar">
          <SelectField
            label="Section type"
            value={adding}
            onChange={(e) => setAdding(e.target.value as SectionType)}
            options={[
              { value: "", label: "Choose a type…" },
              ...known.map((s) => ({ value: s.type, label: s.label })),
            ]}
          />
          <Button
            variant="primary"
            disabled={!adding}
            onClick={() => adding && setEditor({ type: adding })}
          >
            Add section
          </Button>
        </div>
      )}
      {sections.length === 0 ? (
        <EmptyState title="No sections yet" hint="Add a section to start building this page." />
      ) : (
        <ol className="pg-sections" aria-label="Page sections">
          {sections.map((s, i) => {
            const spec = SPEC_BY_TYPE[s.type];
            return (
              <li key={s.id} className={s.isEnabled ? undefined : "pg-off"}>
                <div className="pg-sec-main">
                  <strong>{spec?.label ?? s.type}</strong>{" "}
                  {!s.isEnabled && <Badge tone="neutral">disabled</Badge>}{" "}
                  {(s.startsAt || s.endsAt) && <Badge tone="info">scheduled</Badge>}
                  <div className="muted">{summarize(s.type, s.content)}</div>
                </div>
                {canWrite && (
                  <div className="g-actions">
                    <Button
                      aria-label={`Move ${spec?.label ?? s.type} section up`}
                      disabled={i === 0}
                      onClick={() => void move(i, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      aria-label={`Move ${spec?.label ?? s.type} section down`}
                      disabled={i === sections.length - 1}
                      onClick={() => void move(i, 1)}
                    >
                      ↓
                    </Button>
                    <Button onClick={() => void toggle(s)}>
                      {s.isEnabled ? "Disable" : "Enable"}
                    </Button>
                    <Button onClick={() => setEditor({ type: s.type as SectionType, section: s })}>
                      Edit
                    </Button>
                    <Button variant="danger" onClick={() => setToDelete(s)}>
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {editor && (
        <SectionEditor
          pageId={pageId}
          type={editor.type}
          section={editor.section}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setAdding("");
            refresh();
          }}
        />
      )}
      {toDelete && (
        <ConfirmDialog
          danger
          title="Delete section"
          message={`Delete this ${SPEC_BY_TYPE[toDelete.type]?.label ?? toDelete.type} section?`}
          confirmLabel="Delete"
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            try {
              await api.delete(`/pages/${pageId}/sections/${toDelete.id}`);
              toast.success("Section deleted");
              refresh();
            } catch (e) {
              toast.error(e);
            }
            setToDelete(null);
          }}
        />
      )}
    </Card>
  );
}

export function SectionEditor({
  pageId,
  type,
  section,
  onClose,
  onSaved,
}: {
  pageId: string;
  type: SectionType;
  section?: Section;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const spec = SPEC_BY_TYPE[type]!;
  const [content, setContent] = useState<Content>(section ? section.content : { ...spec.defaults });
  const [jsonText, setJsonText] = useState(
    type === "CUSTOM_JSON" ? JSON.stringify(section?.content ?? {}, null, 2) : "",
  );
  const [isEnabled, setEnabled] = useState(section?.isEnabled ?? true);
  const [key, setKey] = useState(section?.key ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInput(section?.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(section?.endsAt));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    const errs = validateContent(type, content, jsonText);
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))
      errs.endsAt = "Must be after the start";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const finalContent =
        type === "CUSTOM_JSON" ? JSON.parse(jsonText) : ((cleanContent(content) as Content) ?? {});
      const sched = section
        ? {
            startsAt: fromLocalInput(startsAt),
            endsAt: fromLocalInput(endsAt),
            key: key.trim() || null,
          }
        : {
            ...(startsAt ? { startsAt: fromLocalInput(startsAt) } : {}),
            ...(endsAt ? { endsAt: fromLocalInput(endsAt) } : {}),
            ...(key.trim() ? { key: key.trim() } : {}),
          };
      if (section)
        await api.patch(`/pages/${pageId}/sections/${section.id}`, {
          content: finalContent,
          isEnabled,
          ...sched,
        });
      else
        await api.post(`/pages/${pageId}/sections`, {
          type,
          content: finalContent,
          isEnabled,
          ...sched,
        });
      toast.success(section ? "Section saved" : "Section added");
      onSaved();
    } catch (e) {
      handleSaveError(e, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }

  const listed = Object.entries(errors);
  return (
    <Modal
      wide
      title={`${section ? "Edit" : "Add"} ${spec.label} section`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {section ? "Save section" : "Add section"}
          </Button>
        </>
      }
    >
      <p className="muted">{spec.description}</p>
      {listed.length > 0 && (
        <div className="alert-box" role="alert" aria-label="Validation errors">
          <strong>Please fix the following</strong>
          <ul>
            {listed.map(([path, msg]) => (
              <li key={path}>
                <code>{path}</code>: {msg}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="g-stack">
        <SectionContentForm
          type={type}
          value={content}
          onChange={setContent}
          errors={errors}
          jsonText={jsonText}
          onJsonText={setJsonText}
        />
        <fieldset className="g-checklist" style={{ maxHeight: "none" }}>
          <legend>Visibility</legend>
          <CheckField
            label="Enabled"
            checked={isEnabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <div className="form-grid">
            <TextField
              label="Show from"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              error={errors.startsAt}
            />
            <TextField
              label="Show until"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              error={errors.endsAt}
            />
            <TextField
              label="Key (optional)"
              maxLength={80}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              hint="Stable identifier for storefront lookups"
              error={errors.key}
            />
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
