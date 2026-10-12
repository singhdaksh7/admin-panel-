/**
 * Small building blocks shared by the growth/content/system screens
 * (image field, tabs, entity pickers, date helpers, API-error mapping).
 * Lives in the media feature because shared component folders are owned by the shell.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "../../lib/api";
import { MediaPicker, MediaThumb } from "../../components/MediaPicker";
import { Button, useDebounced } from "../../components/ui";
import "./shared.css";

/* ───────── API error mapping ───────── */

export type FieldErrors = Record<string, string>;

/** Map an API error to field errors (returns true when it did) else calls `toast`. */
export function handleSaveError(
  err: unknown,
  setErrors: (e: FieldErrors) => void,
  toast: { error(e: unknown): void },
): void {
  if (err instanceof ApiError) {
    const fe = err.fieldErrors();
    if (Object.keys(fe).length) {
      setErrors(fe);
      toast.error(new Error(err.message));
      return;
    }
  }
  toast.error(err);
}

/* ───────── date helpers (datetime-local <-> ISO) ───────── */

const pad = (n: number) => String(n).padStart(2, "0");
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ───────── Tabs ───────── */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label = "Sections",
}: {
  tabs: { key: T; label: string; badge?: ReactNode }[];
  value: T;
  onChange: (k: T) => void;
  label?: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          className="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
        >
          {t.label} {t.badge}
        </button>
      ))}
    </div>
  );
}

/* ───────── Image field (MediaPicker) ───────── */

export function ImageField({
  label,
  value,
  onChange,
  hint,
  error,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  hint?: string;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <span className="g-label">{label}</span>
      <div className="g-image-field">
        <MediaThumb id={value} size={64} />
        <Button type="button" onClick={() => setOpen(true)}>
          {value ? "Change image" : "Choose image"}
        </Button>
        {value && (
          <Button type="button" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
      {hint && !error && <small className="muted">{hint}</small>}
      {error && (
        <small className="field-error" role="alert">
          {error}
        </small>
      )}
      {open && (
        <MediaPicker
          onClose={() => setOpen(false)}
          onSelect={(items) => {
            onChange(items[0]?.id ?? null);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ───────── Entity data hooks ───────── */

export interface CategoryLite {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}
export function useCategories() {
  return useQuery({
    queryKey: ["g-categories-flat"],
    queryFn: () => api.get<{ items: CategoryLite[] }>("/categories", { flat: true }),
    staleTime: 60_000,
  });
}
export interface CollectionLite {
  id: string;
  name: string;
  slug: string;
}
export function useCollections() {
  return useQuery({
    queryKey: ["g-collections"],
    queryFn: () => api.get<{ items: CollectionLite[] }>("/collections"),
    staleTime: 60_000,
  });
}
export interface AttributeLite {
  id: string;
  name: string;
  slug: string;
}
export function useAttributes() {
  return useQuery({
    queryKey: ["g-attributes"],
    queryFn: () => api.get<{ items: AttributeLite[] }>("/attributes"),
    staleTime: 60_000,
  });
}

/** Category names with indentation by ancestry depth. */
export function categoryOptions(items: CategoryLite[]): { value: string; label: string }[] {
  const byParent = new Map<string | null, CategoryLite[]>();
  for (const c of items) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const out: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  const walk = (p: string | null, depth: number) => {
    for (const c of byParent.get(p) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ value: c.id, label: `${"— ".repeat(depth)}${c.name}` });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const c of items) if (!seen.has(c.id)) out.push({ value: c.id, label: c.name });
  return out;
}

/* ───────── Multi pickers ───────── */

export function CategoryMultiPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const cats = useCategories();
  const opts = categoryOptions(cats.data?.items ?? []);
  return (
    <fieldset className="g-checklist">
      <legend>{label}</legend>
      {cats.isLoading && <span className="muted">Loading…</span>}
      {!cats.isLoading && opts.length === 0 && <span className="muted">No categories</span>}
      {opts.map((o) => (
        <label key={o.value}>
          <input
            type="checkbox"
            checked={value.includes(o.value)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))
            }
          />{" "}
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

interface ProductLite {
  id: string;
  title: string;
  slug: string;
}
function ProductChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const q = useQuery({
    queryKey: ["g-product", id],
    queryFn: () => api.get<ProductLite>(`/products/${id}`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <span className="g-chip">
      {q.data?.title ?? id}
      <button type="button" aria-label={`Remove ${q.data?.title ?? id}`} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

export function ProductMultiPicker({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
  max?: number;
}) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const res = useQuery({
    queryKey: ["g-product-search", q],
    queryFn: () => api.get<Paginated<ProductLite>>("/products", { q, pageSize: 8 }),
    enabled: q.length >= 2,
  });
  return (
    <div className="g-picker">
      <span className="g-label">{label}</span>
      <div className="g-chips">
        {value.map((id) => (
          <ProductChip key={id} id={id} onRemove={() => onChange(value.filter((v) => v !== id))} />
        ))}
        {value.length === 0 && <span className="muted">None selected</span>}
      </div>
      <input
        type="search"
        className="search"
        aria-label={`Search products for ${label}`}
        placeholder="Search products to add…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {q.length >= 2 && (
        <ul className="g-results">
          {res.isLoading && <li className="muted">Searching…</li>}
          {res.data?.items.length === 0 && <li className="muted">No matches</li>}
          {res.data?.items
            .filter((p) => !value.includes(p.id))
            .map((p) => (
              <li key={p.id}>
                <span>{p.title}</span>
                <Button
                  type="button"
                  disabled={max !== undefined && value.length >= max}
                  onClick={() => onChange([...value, p.id])}
                >
                  Add
                </Button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
