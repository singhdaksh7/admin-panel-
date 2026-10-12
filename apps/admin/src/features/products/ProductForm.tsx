import { useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import { MediaPicker } from "../../components/MediaPicker";
import {
  Button,
  Card,
  CheckField,
  ConfirmDialog,
  ErrorState,
  PageHeader,
  SelectField,
  Spinner,
  TextArea,
  TextField,
  useToast,
} from "../../components/ui";
import { DECIMAL, ErrorSummary, applyApiError, flattenTree } from "./kit";
import {
  useAttributes,
  useCategoryTree,
  useCollectionsList,
  useTaxClasses,
  type ProductDetail,
  type ProductStatus,
} from "./types";
import {
  VariantsManager,
  comboOf,
  draftFromVariant,
  validateVariant,
  variantPayload,
  type VariantDraft,
  type VariantRow,
} from "./VariantsManager";

interface Form {
  title: string;
  slug: string;
  slugEdited: boolean;
  shortDescription: string;
  description: string;
  status: ProductStatus;
  publishAt: string;
  unpublishAt: string;
  brand: string;
  isFeatured: boolean;
  isNew: boolean;
  categoryId: string;
  taxClassId: string;
  tags: string[];
  collectionIds: string[];
  images: { mediaId: string; url: string }[];
  attrValueIds: string[];
  price: string;
  compareAtPrice: string;
  cost: string;
  sku: string;
  barcode: string;
  stock: string;
  trackInventory: boolean;
  seoTitle: string;
  seoDescription: string;
  noIndex: boolean;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

function initialForm(p: ProductDetail | null): Form {
  const v = p && p.variants.length === 1 ? p.variants[0]! : null;
  return {
    title: p?.title ?? "",
    slug: p?.slug ?? "",
    slugEdited: !!p,
    shortDescription: p?.shortDescription ?? "",
    description: p?.description ?? "",
    status: p?.status ?? "DRAFT",
    publishAt: toLocalInput(p?.publishAt ?? null),
    unpublishAt: toLocalInput(p?.unpublishAt ?? null),
    brand: p?.brand ?? "",
    isFeatured: p?.isFeatured ?? false,
    isNew: p?.isNew ?? false,
    categoryId: p?.categoryId ?? "",
    taxClassId: p?.taxClassId ?? "",
    tags: p?.tags.map((t) => t.name) ?? [],
    collectionIds: p?.collections.map((c) => c.id) ?? [],
    images: p?.images.map((i) => ({ mediaId: i.mediaId, url: i.url })) ?? [],
    attrValueIds: p?.attributeValues.map((a) => a.valueId) ?? [],
    price: v?.price ?? "",
    compareAtPrice: v?.compareAtPrice ?? "",
    cost: v?.cost ?? "",
    sku: v?.sku ?? "",
    barcode: v?.barcode ?? "",
    stock: v?.inventory?.onHand.toString() ?? "0",
    trackInventory: v?.inventory?.trackInventory ?? true,
    seoTitle: p?.seo?.title ?? "",
    seoDescription: p?.seo?.description ?? "",
    noIndex: p?.seo?.noIndex ?? false,
  };
}

function TagsInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const parts = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onChange([...new Set([...tags, ...parts])]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    }
  };
  return (
    <div>
      <TextField
        label="Tags"
        hint="Press Enter or comma to add"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
      />
      <div className="ops-chips">
        {tags.map((t) => (
          <span className="ops-chip" key={t}>
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ProductForm() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ["product", id],
    queryFn: () => api.get<ProductDetail>(`/products/${id}`),
    enabled: !!id,
  });
  if (!id) return <ProductEditor product={null} />;
  if (q.isLoading) return <Spinner label="Loading product" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  return <ProductEditor product={q.data!} />;
}

function ProductEditor({ product }: { product: ProductDetail | null }) {
  const isNew = !product;
  const { can } = useAuth();
  const canWrite = can("products.write");
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState<Form>(() => initialForm(product));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState(false);
  const [localVariants, setLocalVariants] = useState<VariantRow[]>([]);
  const [pickImages, setPickImages] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "archive">(null);

  const cats = useCategoryTree();
  const attrs = useAttributes();
  const colls = useCollectionsList();
  const taxes = useTaxClasses();
  const attributes = attrs.data?.items ?? [];
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const catOptions = useMemo(() => flattenTree(cats.data?.items ?? []), [cats.data]);

  const variantCount = isNew ? (multi ? localVariants.length : 1) : product!.variants.length;
  const isSimple = isNew ? !multi : product!.variants.length === 1;

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!f.title.trim()) e.title = "Title is required";
    if (f.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug))
      e.slug = "Lowercase letters, digits and hyphens only";
    if (f.publishAt && f.unpublishAt && new Date(f.unpublishAt) <= new Date(f.publishAt))
      e.unpublishAt = "Must be after the publish date";
    if (isSimple) {
      if (!DECIMAL.test(f.price.trim())) e.price = "Enter a price like 12.50";
      if (f.compareAtPrice.trim()) {
        if (!DECIMAL.test(f.compareAtPrice.trim())) e.compareAtPrice = "Enter a price like 12.50";
        else if (Number(f.compareAtPrice) < Number(f.price))
          e.compareAtPrice = "Must be at least the price";
      }
      if (f.cost.trim() && !DECIMAL.test(f.cost.trim())) e.cost = "Enter an amount like 8.00";
      if (f.sku.trim() && !/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(f.sku.trim()))
        e.sku = "Letters, digits and . _ - / only";
      if (!/^\d+$/.test(f.stock.trim() || "0")) e.stock = "Whole number";
    } else if (isNew) {
      if (localVariants.length === 0) e.variants = "Add at least one variant";
      const combos = new Set<string>();
      const skus = new Set<string>();
      for (const r of localVariants) {
        const c = comboOf(r.draft);
        if (localVariants.length > 1 && !c)
          e.variants = "Every variant of a multi-variant product needs an attribute value";
        if (combos.has(c) && localVariants.length > 1)
          e.variants = "Two variants share the same attribute combination";
        combos.add(c);
        if (skus.has(r.draft.sku)) e.variants = "Duplicate SKU in variants";
        skus.add(r.draft.sku);
      }
    }
    return e;
  }

  const seoValue = () => {
    const seo: Record<string, unknown> = {};
    if (f.seoTitle.trim()) seo.title = f.seoTitle.trim();
    if (f.seoDescription.trim()) seo.description = f.seoDescription.trim();
    if (f.noIndex) seo.noIndex = true;
    if (product?.seo?.ogImageMediaId) seo.ogImageMediaId = product.seo.ogImageMediaId;
    return Object.keys(seo).length ? seo : null;
  };

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        title: f.title.trim(),
        shortDescription: f.shortDescription.trim() || null,
        description: f.description.trim() || null,
        status: f.status,
        categoryId: f.categoryId || null,
        taxClassId: f.taxClassId || null,
        brand: f.brand.trim() || null,
        isFeatured: f.isFeatured,
        isNew: f.isNew,
        publishAt: toIso(f.publishAt),
        unpublishAt: toIso(f.unpublishAt),
        seo: seoValue(),
        imageMediaIds: f.images.map((i) => i.mediaId),
        attributeValueIds: f.attrValueIds,
        tags: f.tags,
        collectionIds: f.collectionIds,
      };
      const simple = {
        price: f.price.trim(),
        compareAtPrice: f.compareAtPrice.trim() || null,
        cost: f.cost.trim() || null,
        barcode: f.barcode.trim() || null,
        ...(f.sku.trim() ? { sku: f.sku.trim() } : {}),
      };
      if (isNew) {
        const body = multi
          ? {
              ...common,
              ...(f.slug ? { slug: f.slug } : {}),
              variants: localVariants.map((r) => variantPayload(r.draft, true)),
            }
          : {
              ...common,
              ...(f.slug ? { slug: f.slug } : {}),
              ...simple,
              stock: Number(f.stock || 0),
              trackInventory: f.trackInventory,
            };
        return api.post<ProductDetail>("/products", body);
      }
      const updated = await api.patch<ProductDetail>(`/products/${product!.id}`, {
        ...common,
        slug: f.slug,
        ...(isSimple ? simple : {}),
      });
      const v = product!.variants[0];
      if (isSimple && v && can("inventory.write")) {
        const stockChanged = Number(f.stock || 0) !== (v.inventory?.onHand ?? 0);
        const trackChanged = f.trackInventory !== (v.inventory?.trackInventory ?? true);
        if (stockChanged || trackChanged)
          await api.patch(`/inventory/${v.id}`, {
            reason: "Edited from product page",
            trackInventory: f.trackInventory,
            ...(stockChanged ? { set: Number(f.stock || 0) } : {}),
          });
      }
      return updated;
    },
    onSuccess: (p) => {
      toast.success(isNew ? "Product created" : "Product saved");
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["product", p.id] });
      if (isNew) nav(`/products/${p.id}`, { replace: true });
    },
    onError: (e) => applyApiError(e, setErrors, toast),
  });

  function submit() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast.error(new Error("Please fix the highlighted fields"));
      return;
    }
    save.mutate();
  }

  // ---- edit-mode variant operations (live API) ----
  const refresh = () => qc.invalidateQueries({ queryKey: ["product", product?.id] });
  const remoteRows: VariantRow[] = (product?.variants ?? []).map((v) => ({
    key: v.id,
    draft: draftFromVariant(v),
    stock: v.inventory?.onHand ?? null,
    isDefault: v.isDefault,
  }));

  async function submitVariant(d: VariantDraft, key: string | null) {
    if (isNew) {
      setLocalVariants((rows) =>
        key
          ? rows.map((r) => (r.key === key ? { ...r, draft: d, stock: Number(d.stock || 0) } : r))
          : [
              ...rows,
              { key: `new-${Date.now()}-${rows.length}`, draft: d, stock: Number(d.stock || 0) },
            ],
      );
      return;
    }
    const withStock = !key;
    if (key) await api.patch(`/products/${product!.id}/variants/${key}`, variantPayload(d, false));
    else await api.post(`/products/${product!.id}/variants`, variantPayload(d, withStock));
    toast.success(key ? "Variant updated" : "Variant added");
    await refresh();
  }
  async function deleteVariant(key: string) {
    if (isNew) {
      setLocalVariants((rows) => rows.filter((r) => r.key !== key));
      return;
    }
    try {
      await api.delete(`/products/${product!.id}/variants/${key}`);
      toast.success("Variant deleted");
      await refresh();
    } catch (e) {
      toast.error(e);
      throw e;
    }
  }

  const duplicate = useMutation({
    mutationFn: () => api.post<ProductDetail>(`/products/${product!.id}/duplicate`),
    onSuccess: (p) => {
      toast.success("Product duplicated as a draft");
      void qc.invalidateQueries({ queryKey: ["products"] });
      nav(`/products/${p.id}`);
    },
    onError: (e) => toast.error(e),
  });

  async function archiveOrDelete() {
    try {
      if (confirm === "delete") {
        await api.delete(`/products/${product!.id}`);
        toast.success("Product deleted");
      } else {
        await api.patch(`/products/${product!.id}`, { status: "ARCHIVED" });
        toast.success("Product archived");
      }
      void qc.invalidateQueries({ queryKey: ["products"] });
      nav("/products");
    } catch (e) {
      toast.error(e);
      setConfirm(null);
    }
  }

  const moveImage = (i: number, d: number) =>
    setF((x) => {
      const imgs = [...x.images];
      const j = i + d;
      if (j < 0 || j >= imgs.length) return x;
      [imgs[i], imgs[j]] = [imgs[j]!, imgs[i]!];
      return { ...x, images: imgs };
    });

  const toggleValue = (vid: string) =>
    set(
      "attrValueIds",
      f.attrValueIds.includes(vid)
        ? f.attrValueIds.filter((x) => x !== vid)
        : [...f.attrValueIds, vid],
    );

  const field = (k: keyof Form, label: string, extra: object = {}) => (
    <TextField
      label={label}
      value={f[k] as string}
      onChange={(e) => set(k, e.target.value as never)}
      error={errors[k]}
      {...extra}
    />
  );

  return (
    <>
      <PageHeader
        title={isNew ? "New product" : product!.title}
        subtitle={isNew ? "Create a catalog product" : `/${product!.slug}`}
        actions={
          <>
            <Link to="/products" className="btn btn-secondary">
              Back to products
            </Link>
            {!isNew && canWrite && (
              <>
                <Button loading={duplicate.isPending} onClick={() => duplicate.mutate()}>
                  Duplicate
                </Button>
                <Button onClick={() => setConfirm("archive")}>Archive</Button>
                <Button variant="danger" onClick={() => setConfirm("delete")}>
                  Delete
                </Button>
              </>
            )}
          </>
        }
      />
      <ErrorSummary
        errors={Object.fromEntries(
          Object.entries(errors).filter(
            ([k]) => !(k in f) && !["variants", "price", "sku"].includes(k),
          ),
        )}
      />
      {errors.variants && (
        <div className="error-state" role="alert">
          {errors.variants}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
        }}
        noValidate
        aria-label="Product form"
      >
        <fieldset disabled={!canWrite} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="ops-sections">
            <Card title="Basics">
              <div className="ops-grid-2">
                <TextField
                  label="Title"
                  value={f.title}
                  onChange={(e) =>
                    setF((x) => ({
                      ...x,
                      title: e.target.value,
                      slug: x.slugEdited ? x.slug : slugify(e.target.value),
                    }))
                  }
                  error={errors.title}
                />
                <TextField
                  label="Slug"
                  hint={isNew ? "Generated from the title unless edited" : undefined}
                  value={f.slug}
                  onChange={(e) => setF((x) => ({ ...x, slug: e.target.value, slugEdited: true }))}
                  error={errors.slug}
                />
              </div>
              <TextArea
                label="Short description"
                rows={2}
                value={f.shortDescription}
                onChange={(e) => set("shortDescription", e.target.value)}
                error={errors.shortDescription}
                hint="Plain text"
              />
              <TextArea
                label="Description"
                rows={8}
                value={f.description}
                onChange={(e) => set("description", e.target.value)}
                error={errors.description}
                hint="Simple HTML is allowed (p, strong, em, ul, ol, li, a, h2-h4, img). It is sanitised on the server."
              />
              <div className="ops-grid-3">
                <SelectField
                  label="Status"
                  value={f.status}
                  onChange={(e) => set("status", e.target.value as ProductStatus)}
                  options={[
                    { value: "DRAFT", label: "Draft" },
                    { value: "ACTIVE", label: "Active" },
                    { value: "ARCHIVED", label: "Archived" },
                  ]}
                />
                {field("publishAt", "Publish at", { type: "datetime-local" })}
                {field("unpublishAt", "Unpublish at", { type: "datetime-local" })}
              </div>
              <div className="ops-grid-3">
                {field("brand", "Brand")}
                <CheckField
                  label="Featured"
                  checked={f.isFeatured}
                  onChange={(e) => set("isFeatured", e.target.checked)}
                />
                <CheckField
                  label="Mark as new"
                  checked={f.isNew}
                  onChange={(e) => set("isNew", e.target.checked)}
                />
              </div>
            </Card>

            <Card title="Organisation">
              <div className="ops-grid-2">
                <SelectField
                  label="Category"
                  value={f.categoryId}
                  onChange={(e) => set("categoryId", e.target.value)}
                  options={[
                    { value: "", label: "— none —" },
                    ...catOptions.map((c) => ({
                      value: c.id,
                      label: `${"— ".repeat(c.depth)}${c.name}`,
                    })),
                  ]}
                />
                <SelectField
                  label="Tax class"
                  value={f.taxClassId}
                  onChange={(e) => set("taxClassId", e.target.value)}
                  options={[
                    { value: "", label: "— default —" },
                    ...(taxes.data?.items ?? []).map((t) => ({
                      value: t.id,
                      label: `${t.name} (${t.rate}%)`,
                    })),
                  ]}
                />
              </div>
              <TagsInput tags={f.tags} onChange={(t) => set("tags", t)} />
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend>Collections</legend>
                <div className="ops-chips">
                  {(colls.data?.items ?? [])
                    .filter((c) => c.type === "MANUAL")
                    .map((c) => (
                      <CheckField
                        key={c.id}
                        label={c.name}
                        checked={f.collectionIds.includes(c.id)}
                        onChange={(e) =>
                          set(
                            "collectionIds",
                            e.target.checked
                              ? [...f.collectionIds, c.id]
                              : f.collectionIds.filter((x) => x !== c.id),
                          )
                        }
                      />
                    ))}
                  {(colls.data?.items ?? []).filter((c) => c.type === "MANUAL").length === 0 && (
                    <span className="muted">No manual collections yet.</span>
                  )}
                </div>
              </fieldset>
            </Card>

            <Card title="Images">
              {f.images.length === 0 && <p className="muted">No images yet.</p>}
              <ul className="ops-images">
                {f.images.map((img, i) => (
                  <li key={img.mediaId}>
                    <img src={img.url} alt={`Product image ${i + 1}`} />
                    <div className="row">
                      <Button
                        aria-label={`Move image ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => moveImage(i, -1)}
                      >
                        ←
                      </Button>
                      <Button
                        aria-label={`Move image ${i + 1} down`}
                        disabled={i === f.images.length - 1}
                        onClick={() => moveImage(i, 1)}
                      >
                        →
                      </Button>
                      <Button
                        variant="danger"
                        aria-label={`Remove image ${i + 1}`}
                        onClick={() =>
                          set(
                            "images",
                            f.images.filter((x) => x.mediaId !== img.mediaId),
                          )
                        }
                      >
                        ×
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <Button onClick={() => setPickImages(true)}>Add images</Button>
              {errors.imageMediaIds && <p className="field-error">{errors.imageMediaIds}</p>}
              {pickImages && (
                <MediaPicker
                  multiple
                  onClose={() => setPickImages(false)}
                  onSelect={(items) => {
                    setF((x) => ({
                      ...x,
                      images: [
                        ...x.images,
                        ...items
                          .filter((m) => !x.images.some((i) => i.mediaId === m.id))
                          .map((m) => ({ mediaId: m.id, url: m.url })),
                      ],
                    }));
                    setPickImages(false);
                  }}
                />
              )}
            </Card>

            {attributes.length > 0 && (
              <Card title="Attributes">
                <p className="muted">
                  Product-level attribute values (shown on the product page and used by filters).
                </p>
                {attributes
                  .filter((a) => a.values.length > 0)
                  .map((a) => (
                    <div key={a.id}>
                      <strong>{a.name}</strong>
                      <div className="ops-chips">
                        {a.values.map((v) => (
                          <button
                            type="button"
                            key={v.id}
                            className={`ops-chip${f.attrValueIds.includes(v.id) ? " on" : ""}`}
                            aria-pressed={f.attrValueIds.includes(v.id)}
                            onClick={() => toggleValue(v.id)}
                          >
                            {v.value}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
              </Card>
            )}

            {isSimple && (
              <Card title="Pricing and inventory">
                <div className="ops-grid-3">
                  {field("price", "Price", { inputMode: "decimal" })}
                  {field("compareAtPrice", "Compare-at price", { inputMode: "decimal" })}
                  {field("cost", "Cost per item", { inputMode: "decimal" })}
                  {field("sku", "SKU", { hint: isNew ? "Generated if left blank" : undefined })}
                  {field("barcode", "Barcode")}
                  {field("stock", "Stock quantity", {
                    inputMode: "numeric",
                    disabled: !isNew && !can("inventory.write"),
                  })}
                </div>
                <CheckField
                  label="Track inventory"
                  checked={f.trackInventory}
                  onChange={(e) => set("trackInventory", e.target.checked)}
                />
              </Card>
            )}
          </div>
        </fieldset>

        <div className="ops-sections" style={{ marginTop: 16 }}>
          <Card
            title={`Variants (${variantCount})`}
            actions={
              isNew ? (
                <CheckField
                  label="This product has multiple variants"
                  checked={multi}
                  disabled={!canWrite}
                  onChange={(e) => setMulti(e.target.checked)}
                />
              ) : undefined
            }
          >
            {isNew && !multi ? (
              <p className="muted">
                Simple product with a single default variant. Tick &quot;multiple variants&quot; to
                define sizes, colours, etc.
              </p>
            ) : (
              <VariantsManager
                rows={isNew ? localVariants : remoteRows}
                attributes={attributes}
                canWrite={canWrite}
                stockOnAdd
                onSubmit={submitVariant}
                onDelete={deleteVariant}
              />
            )}
          </Card>

          <fieldset disabled={!canWrite} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <Card title="Search engine listing">
              {field("seoTitle", "SEO title")}
              <TextArea
                label="SEO description"
                rows={2}
                value={f.seoDescription}
                onChange={(e) => set("seoDescription", e.target.value)}
              />
              <CheckField
                label="Hide from search engines (noindex)"
                checked={f.noIndex}
                onChange={(e) => set("noIndex", e.target.checked)}
              />
            </Card>
          </fieldset>
        </div>

        {canWrite && (
          <div className="ops-sticky-bar">
            <Button type="button" variant="primary" loading={save.isPending} onClick={submit}>
              {isNew ? "Create product" : "Save changes"}
            </Button>
          </div>
        )}
      </form>

      {confirm && (
        <ConfirmDialog
          danger
          title={confirm === "delete" ? "Delete product" : "Archive product"}
          message={
            confirm === "delete"
              ? "Permanently delete this product? Products with order history cannot be deleted; archive them instead."
              : "Archive this product? It will be hidden from the storefront but kept for order history."
          }
          confirmLabel={confirm === "delete" ? "Delete" : "Archive"}
          onCancel={() => setConfirm(null)}
          onConfirm={archiveOrDelete}
        />
      )}
    </>
  );
}

// re-export for tests that want to validate variants directly
export { validateVariant };
