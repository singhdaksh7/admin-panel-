import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import { MediaPicker, MediaThumb } from "../../components/MediaPicker";
import {
  Badge,
  Button,
  CheckField,
  DataTable,
  EmptyState,
  Modal,
  PageHeader,
  SelectField,
  TextArea,
  TextField,
  useToast,
} from "../../components/ui";
import {
  ErrorSummary,
  ListState,
  applyApiError,
  descendantIds,
  flattenTree,
  type CategoryNode,
  type FlatCategory,
} from "../products/kit";
import { useCategoryTree } from "../products/types";

interface CatForm {
  name: string;
  slug: string;
  parentId: string;
  description: string;
  imageMediaId: string;
  bannerMediaId: string;
  sortOrder: string;
  isActive: boolean;
  seoTitle: string;
  seoDescription: string;
  noIndex: boolean;
}

const fromNode = (c: CategoryNode | null, parentId = ""): CatForm => ({
  name: c?.name ?? "",
  slug: c?.slug ?? "",
  parentId: c?.parentId ?? parentId,
  description: c?.description ?? "",
  imageMediaId: c?.imageMediaId ?? "",
  bannerMediaId: c?.bannerMediaId ?? "",
  sortOrder: String(c?.sortOrder ?? 0),
  isActive: c?.isActive ?? true,
  seoTitle: c?.seo?.title ?? "",
  seoDescription: c?.seo?.description ?? "",
  noIndex: c?.seo?.noIndex ?? false,
});

function CategoryDialog({
  category,
  tree,
  onClose,
}: {
  category: FlatCategory | null;
  tree: CategoryNode[];
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState(() => fromNode(category));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pick, setPick] = useState<null | "imageMediaId" | "bannerMediaId">(null);
  const set = <K extends keyof CatForm>(k: K, v: CatForm[K]) => setF((x) => ({ ...x, [k]: v }));

  const excluded = new Set<string>();
  if (category) {
    excluded.add(category.id);
    descendantIds(category).forEach((i) => excluded.add(i));
  }
  const parents = flattenTree(tree).filter((c) => !excluded.has(c.id));

  const save = useMutation({
    mutationFn: () => {
      const seo: Record<string, unknown> = {};
      if (f.seoTitle.trim()) seo.title = f.seoTitle.trim();
      if (f.seoDescription.trim()) seo.description = f.seoDescription.trim();
      if (f.noIndex) seo.noIndex = true;
      const body = {
        name: f.name.trim(),
        ...(f.slug.trim() ? { slug: f.slug.trim() } : {}),
        parentId: f.parentId || null,
        description: f.description.trim() || null,
        imageMediaId: f.imageMediaId || null,
        bannerMediaId: f.bannerMediaId || null,
        sortOrder: Number(f.sortOrder || 0),
        isActive: f.isActive,
        seo: Object.keys(seo).length ? seo : null,
      };
      return category
        ? api.patch(`/categories/${category.id}`, body)
        : api.post("/categories", body);
    },
    onSuccess: () => {
      toast.success(category ? "Category saved" : "Category created");
      void qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
    onError: (e) => applyApiError(e, setErrors, toast),
  });

  function submit() {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = "Name is required";
    if (f.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug.trim()))
      e.slug = "Lowercase letters, digits and hyphens only";
    if (!/^-?\d+$/.test(f.sortOrder.trim() || "0")) e.sortOrder = "Whole number";
    setErrors(e);
    if (!Object.keys(e).length) save.mutate();
  }

  const media = (k: "imageMediaId" | "bannerMediaId", label: string) => (
    <div>
      <strong>{label}</strong>
      <div className="ops-cell">
        <MediaThumb id={f[k]} size={64} />
        <Button onClick={() => setPick(k)}>{f[k] ? "Change" : "Choose"}</Button>
        {f[k] && (
          <Button variant="ghost" onClick={() => set(k, "")}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      title={category ? `Edit ${category.name}` : "New category"}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save category
          </Button>
        </>
      }
    >
      <ErrorSummary
        errors={Object.fromEntries(Object.entries(errors).filter(([k]) => !(k in f)))}
      />
      <div className="ops-grid-2">
        <TextField
          label="Name"
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
          error={errors.name}
        />
        <TextField
          label="Slug"
          hint="Generated from the name if blank"
          value={f.slug}
          onChange={(e) => set("slug", e.target.value)}
          error={errors.slug}
        />
        <SelectField
          label="Parent category"
          value={f.parentId}
          onChange={(e) => set("parentId", e.target.value)}
          error={errors.parentId}
          options={[
            { value: "", label: "— top level —" },
            ...parents.map((c) => ({ value: c.id, label: `${"— ".repeat(c.depth)}${c.name}` })),
          ]}
        />
        <TextField
          label="Sort order"
          inputMode="numeric"
          value={f.sortOrder}
          onChange={(e) => set("sortOrder", e.target.value)}
          error={errors.sortOrder}
        />
      </div>
      <TextArea
        label="Description"
        rows={3}
        value={f.description}
        onChange={(e) => set("description", e.target.value)}
        error={errors.description}
      />
      <div className="ops-grid-2">
        {media("imageMediaId", "Image")}
        {media("bannerMediaId", "Banner")}
      </div>
      <CheckField
        label="Active"
        checked={f.isActive}
        onChange={(e) => set("isActive", e.target.checked)}
      />
      <div className="ops-grid-2">
        <TextField
          label="SEO title"
          value={f.seoTitle}
          onChange={(e) => set("seoTitle", e.target.value)}
        />
        <TextField
          label="SEO description"
          value={f.seoDescription}
          onChange={(e) => set("seoDescription", e.target.value)}
        />
      </div>
      <CheckField
        label="Hide from search engines (noindex)"
        checked={f.noIndex}
        onChange={(e) => set("noIndex", e.target.checked)}
      />
      {pick && (
        <MediaPicker
          onClose={() => setPick(null)}
          onSelect={(items) => {
            set(pick, items[0]!.id);
            setPick(null);
          }}
        />
      )}
    </Modal>
  );
}

function DeleteDialog({
  category,
  all,
  onClose,
}: {
  category: FlatCategory;
  all: FlatCategory[];
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [target, setTarget] = useState("none");
  const hasChildren = category.children.length > 0;
  const options = all.filter((c) => c.id !== category.id);
  const del = useMutation({
    mutationFn: () =>
      api.delete(
        `/categories/${category.id}${category.productCount > 0 ? `?reassignTo=${encodeURIComponent(target)}` : ""}`,
      ),
    onSuccess: () => {
      toast.success("Category deleted");
      void qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Modal
      title="Delete category"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={hasChildren}
            loading={del.isPending}
            onClick={() => del.mutate()}
          >
            Delete category
          </Button>
        </>
      }
    >
      <p>
        Delete <strong>{category.name}</strong>?
      </p>
      {hasChildren && (
        <p className="field-error" role="alert">
          This category has sub-categories. Move or delete them first.
        </p>
      )}
      {category.productCount > 0 && (
        <SelectField
          label={`${category.productCount} product(s) use this category. Move them to`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          options={[
            { value: "none", label: "No category" },
            ...options.map((c) => ({ value: c.id, label: `${"— ".repeat(c.depth)}${c.name}` })),
          ]}
        />
      )}
    </Modal>
  );
}

export function Categories() {
  const { can } = useAuth();
  const canWrite = can("categories.write");
  const q = useCategoryTree();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<FlatCategory | "new" | null>(null);
  const [deleting, setDeleting] = useState<FlatCategory | null>(null);
  const tree = q.data?.items ?? [];
  const flat = flattenTree(tree);

  const move = useMutation({
    mutationFn: ({ c, dir }: { c: FlatCategory; dir: -1 | 1 }) => {
      const siblings = flat
        .filter((x) => x.parentId === c.parentId)
        .sort((a, b) => a.index - b.index);
      const i = siblings.findIndex((s) => s.id === c.id);
      const j = i + dir;
      const reordered = [...siblings];
      [reordered[i], reordered[j]] = [reordered[j]!, reordered[i]!];
      return api.post("/categories/reorder", {
        items: reordered.map((s, idx) => ({ id: s.id, sortOrder: idx })),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["categories"] }),
    onError: (e) => toast.error(e),
  });

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle="Organise products into a category tree"
        actions={
          <Can perm="categories.write">
            <Button variant="primary" onClick={() => setEditing("new")}>
              New category
            </Button>
          </Can>
        }
      />
      <ListState
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        retry={() => void q.refetch()}
        empty={
          q.data && flat.length === 0 ? (
            <EmptyState title="No categories yet" hint="Create your first category." />
          ) : undefined
        }
      >
        <DataTable
          caption="Categories"
          rows={flat}
          rowKey={(c) => c.id}
          columns={[
            {
              key: "name",
              header: "Name",
              render: (c) => (
                <div className="ops-tree-row" style={{ paddingLeft: c.depth * 20 }}>
                  {c.depth > 0 && <span aria-hidden="true">↳</span>}
                  <strong>{c.name}</strong>
                  <small className="muted">/{c.slug}</small>
                </div>
              ),
            },
            { key: "n", header: "Products", render: (c) => c.productCount },
            {
              key: "s",
              header: "Status",
              render: (c) =>
                c.isActive ? <Badge tone="success">active</Badge> : <Badge>hidden</Badge>,
            },
            {
              key: "a",
              header: "",
              render: (c) =>
                canWrite && (
                  <div className="ops-actions">
                    <Button
                      aria-label={`Move ${c.name} up`}
                      disabled={c.index === 0 || move.isPending}
                      onClick={() => move.mutate({ c, dir: -1 })}
                    >
                      ↑
                    </Button>
                    <Button
                      aria-label={`Move ${c.name} down`}
                      disabled={c.index === c.siblings - 1 || move.isPending}
                      onClick={() => move.mutate({ c, dir: 1 })}
                    >
                      ↓
                    </Button>
                    <Button aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => setDeleting(c)}
                    >
                      Delete
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      </ListState>
      {editing && (
        <CategoryDialog
          category={editing === "new" ? null : editing}
          tree={tree}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteDialog category={deleting} all={flat} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}
