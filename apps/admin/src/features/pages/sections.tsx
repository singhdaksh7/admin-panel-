/**
 * Section type registry + per-type form. Mirrors the zod shapes in
 * apps/api/src/modules/content/sectionTypes.ts (the API only exposes the list of type names).
 */
import { SelectField, TextArea, TextField, CheckField } from "../../components/ui";
import {
  CategoryMultiPicker,
  ImageField,
  ProductMultiPicker,
  categoryOptions,
  useCategories,
  useCollections,
  type FieldErrors,
} from "../media/shared";

export type SectionType =
  | "HERO"
  | "PROMO_BANNER"
  | "TEXT"
  | "IMAGE"
  | "PRODUCT_GRID"
  | "CATEGORY_GRID"
  | "RICH_TEXT"
  | "REVIEWS"
  | "BLOG_PREVIEW"
  | "CUSTOM_JSON";

export type Content = Record<string, unknown>;

type Opt = { value: string; label: string };
type Field =
  | {
      kind: "text" | "textarea" | "color";
      path: string;
      label: string;
      required?: boolean;
      max?: number;
      hint?: string;
    }
  | {
      kind: "number";
      path: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      hint?: string;
    }
  | {
      kind: "select";
      path: string;
      label: string;
      options: Opt[];
      numeric?: boolean;
      allowEmpty?: boolean;
    }
  | { kind: "bool"; path: string; label: string }
  | { kind: "asset"; path: string; label: string; required?: boolean }
  | { kind: "cta"; path: string; label: string }
  | { kind: "products"; path: string; label: string; max: number }
  | { kind: "categories"; path: string; label: string }
  | { kind: "categorySelect" | "collectionSelect"; path: string; label: string };

const ALIGN: Opt[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

export interface SectionSpec {
  type: SectionType;
  label: string;
  description: string;
  defaults: Content;
  fields: Field[];
}

export const SECTION_SPECS: SectionSpec[] = [
  {
    type: "HERO",
    label: "Hero",
    description: "Large banner with heading, image and call-to-action buttons",
    defaults: { align: "left" },
    fields: [
      { kind: "text", path: "heading", label: "Heading", required: true, max: 200 },
      { kind: "textarea", path: "subheading", label: "Subheading", max: 500 },
      { kind: "asset", path: "image", label: "Image" },
      { kind: "cta", path: "cta", label: "Primary button" },
      { kind: "cta", path: "secondaryCta", label: "Secondary button" },
      { kind: "select", path: "align", label: "Alignment", options: ALIGN },
      {
        kind: "number",
        path: "overlayOpacity",
        label: "Overlay opacity (0-1)",
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    type: "PROMO_BANNER",
    label: "Promo banner",
    description: "Thin announcement or promotion strip",
    defaults: {},
    fields: [
      { kind: "text", path: "text", label: "Text", required: true, max: 300 },
      { kind: "cta", path: "cta", label: "Button" },
      { kind: "asset", path: "image", label: "Background image" },
      { kind: "color", path: "backgroundColor", label: "Background colour" },
      { kind: "color", path: "textColor", label: "Text colour" },
    ],
  },
  {
    type: "TEXT",
    label: "Text",
    description: "Heading with a text block",
    defaults: { align: "left" },
    fields: [
      { kind: "text", path: "heading", label: "Heading", max: 200 },
      { kind: "textarea", path: "body", label: "Body", required: true, max: 20000 },
      { kind: "select", path: "align", label: "Alignment", options: ALIGN },
    ],
  },
  {
    type: "IMAGE",
    label: "Image",
    description: "A single responsive image",
    defaults: {},
    fields: [
      { kind: "asset", path: "image", label: "Image", required: true },
      {
        kind: "text",
        path: "linkUrl",
        label: "Link URL",
        max: 1000,
        hint: "/path, https://, mailto: or tel:",
      },
      { kind: "text", path: "caption", label: "Caption", max: 300 },
    ],
  },
  {
    type: "PRODUCT_GRID",
    label: "Product grid",
    description: "Hand-picked or rule-based products",
    defaults: { sort: "newest", limit: 8 },
    fields: [
      { kind: "text", path: "heading", label: "Heading", max: 200 },
      { kind: "products", path: "productIds", label: "Specific products", max: 48 },
      { kind: "categorySelect", path: "categoryId", label: "Or from category" },
      { kind: "collectionSelect", path: "collectionSlug", label: "Or from collection" },
      { kind: "bool", path: "featuredOnly", label: "Featured products only" },
      {
        kind: "select",
        path: "sort",
        label: "Sort",
        options: [
          { value: "newest", label: "Newest" },
          { value: "featured", label: "Featured" },
          { value: "manual", label: "Manual order" },
        ],
      },
      { kind: "number", path: "limit", label: "Limit", min: 1, max: 48 },
      { kind: "cta", path: "cta", label: "View-all button" },
    ],
  },
  {
    type: "CATEGORY_GRID",
    label: "Category grid",
    description: "Tiles linking to categories",
    defaults: { limit: 8 },
    fields: [
      { kind: "text", path: "heading", label: "Heading", max: 200 },
      { kind: "categories", path: "categoryIds", label: "Categories" },
      { kind: "number", path: "limit", label: "Limit", min: 1, max: 48 },
    ],
  },
  {
    type: "RICH_TEXT",
    label: "Rich text (HTML)",
    description: "Free-form sanitized HTML",
    defaults: {},
    fields: [{ kind: "textarea", path: "html", label: "HTML", required: true, max: 100000 }],
  },
  {
    type: "REVIEWS",
    label: "Reviews",
    description: "Approved customer reviews",
    defaults: { limit: 6 },
    fields: [
      { kind: "text", path: "heading", label: "Heading", max: 200 },
      { kind: "text", path: "productSlug", label: "Product slug (optional)", max: 160 },
      {
        kind: "select",
        path: "minRating",
        label: "Minimum rating",
        numeric: true,
        allowEmpty: true,
        options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}+ stars` })),
      },
      { kind: "number", path: "limit", label: "Limit", min: 1, max: 24 },
    ],
  },
  {
    type: "BLOG_PREVIEW",
    label: "Blog preview",
    description: "Latest blog posts",
    defaults: { limit: 3 },
    fields: [
      { kind: "text", path: "heading", label: "Heading", max: 200 },
      { kind: "text", path: "tag", label: "Only posts with tag", max: 60 },
      { kind: "number", path: "limit", label: "Limit", min: 1, max: 24 },
    ],
  },
  {
    type: "CUSTOM_JSON",
    label: "Custom JSON",
    description: "Arbitrary JSON for custom storefront components (max 64 KB)",
    defaults: {},
    fields: [],
  },
];

export const SPEC_BY_TYPE = Object.fromEntries(SECTION_SPECS.map((s) => [s.type, s])) as Record<
  string,
  SectionSpec
>;

/* ───────── path helpers ───────── */

export function getAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Content | undefined)?.[k], obj);
}
export function setAt(obj: Content, path: string, value: unknown): Content {
  const [head, ...rest] = path.split(".");
  if (!head) return obj;
  if (!rest.length) return { ...obj, [head]: value };
  return { ...obj, [head]: setAt((obj[head] as Content) ?? {}, rest.join("."), value) };
}

/** Drop empty strings / empty arrays / empty objects / undefined recursively (keeps false and 0). */
export function cleanContent(v: unknown): unknown {
  if (Array.isArray(v)) {
    const a = v.map(cleanContent).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === "object") {
    const o: Content = {};
    for (const [k, x] of Object.entries(v)) {
      const c = cleanContent(x);
      if (c !== undefined) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  if (v === "" || v === undefined || v === null || (typeof v === "number" && Number.isNaN(v)))
    return undefined;
  return v;
}

/** Client-side required checks -> errors keyed like the API (`content.<path>`). */
export function validateContent(type: string, content: Content, jsonText?: string): FieldErrors {
  const e: FieldErrors = {};
  const spec = SPEC_BY_TYPE[type];
  if (!spec) return { content: "Unknown section type" };
  if (type === "CUSTOM_JSON") {
    try {
      const p = JSON.parse(jsonText ?? "");
      if (!p || typeof p !== "object" || Array.isArray(p)) e.content = "Must be a JSON object";
    } catch {
      e.content = "Invalid JSON";
    }
    return e;
  }
  for (const f of spec.fields) {
    if (f.kind === "asset" && f.required && !getAt(content, `${f.path}.desktopMediaId`))
      e[`content.${f.path}.desktopMediaId`] = "Choose a desktop image";
    if (
      (f.kind === "text" || f.kind === "textarea") &&
      f.required &&
      !String(getAt(content, f.path) ?? "").trim()
    )
      e[`content.${f.path}`] = `${f.label} is required`;
    if (f.kind === "cta") {
      const label = getAt(content, `${f.path}.label`);
      const url = getAt(content, `${f.path}.url`);
      if (label && !url) e[`content.${f.path}.url`] = "URL is required with a label";
      if (url && !label) e[`content.${f.path}.label`] = "Label is required with a URL";
    }
    if (f.kind === "color") {
      const c = getAt(content, f.path);
      if (c && !/^#[0-9a-fA-F]{3,8}$/.test(String(c)))
        e[`content.${f.path}`] = "Use a hex colour like #112233";
    }
    if (f.kind === "number") {
      const n = getAt(content, f.path);
      if (typeof n === "number" && (n < f.min || n > f.max))
        e[`content.${f.path}`] = `Between ${f.min} and ${f.max}`;
    }
  }
  return e;
}

/* ───────── form ───────── */

export function SectionContentForm({
  type,
  value,
  onChange,
  errors,
  jsonText,
  onJsonText,
}: {
  type: SectionType;
  value: Content;
  onChange: (c: Content) => void;
  errors: FieldErrors;
  jsonText: string;
  onJsonText: (t: string) => void;
}) {
  const spec = SPEC_BY_TYPE[type]!;
  const cats = useCategories();
  const cols = useCollections();
  const err = (p: string) => errors[`content.${p}`];
  const set = (p: string, v: unknown) => onChange(setAt(value, p, v));

  if (type === "CUSTOM_JSON") {
    return (
      <TextArea
        label="Content (JSON object)"
        rows={12}
        spellCheck={false}
        value={jsonText}
        onChange={(e) => onJsonText(e.target.value)}
        error={errors.content}
        style={{ fontFamily: "ui-monospace, monospace" }}
      />
    );
  }

  return (
    <div className="g-stack">
      {spec.fields.map((f) => {
        switch (f.kind) {
          case "text":
          case "color":
            return (
              <TextField
                key={f.path}
                label={f.label}
                maxLength={f.max}
                placeholder={f.kind === "color" ? "#112233" : undefined}
                hint={f.hint}
                value={String(getAt(value, f.path) ?? "")}
                onChange={(e) => set(f.path, e.target.value)}
                error={err(f.path)}
              />
            );
          case "textarea":
            return (
              <TextArea
                key={f.path}
                label={f.label}
                maxLength={f.max}
                rows={f.path === "html" || f.path === "body" ? 8 : 3}
                value={String(getAt(value, f.path) ?? "")}
                onChange={(e) => set(f.path, e.target.value)}
                error={err(f.path)}
              />
            );
          case "number":
            return (
              <TextField
                key={f.path}
                label={f.label}
                type="number"
                min={f.min}
                max={f.max}
                step={f.step ?? 1}
                value={getAt(value, f.path) === undefined ? "" : String(getAt(value, f.path))}
                onChange={(e) =>
                  set(f.path, e.target.value === "" ? undefined : Number(e.target.value))
                }
                error={err(f.path)}
              />
            );
          case "select":
            return (
              <SelectField
                key={f.path}
                label={f.label}
                value={String(getAt(value, f.path) ?? "")}
                onChange={(e) =>
                  set(
                    f.path,
                    e.target.value === ""
                      ? undefined
                      : f.numeric
                        ? Number(e.target.value)
                        : e.target.value,
                  )
                }
                options={f.allowEmpty ? [{ value: "", label: "Any" }, ...f.options] : f.options}
                error={err(f.path)}
              />
            );
          case "bool":
            return (
              <CheckField
                key={f.path}
                label={f.label}
                checked={getAt(value, f.path) === true}
                onChange={(e) => set(f.path, e.target.checked)}
              />
            );
          case "asset":
            return (
              <fieldset key={f.path} className="g-checklist" style={{ maxHeight: "none" }}>
                <legend>{f.label}</legend>
                <ImageField
                  label="Desktop image"
                  value={getAt(value, `${f.path}.desktopMediaId`) as string | undefined}
                  onChange={(id) => set(`${f.path}.desktopMediaId`, id ?? undefined)}
                  error={err(`${f.path}.desktopMediaId`)}
                />
                <ImageField
                  label="Mobile image (optional)"
                  value={getAt(value, `${f.path}.mobileMediaId`) as string | undefined}
                  onChange={(id) => set(`${f.path}.mobileMediaId`, id ?? undefined)}
                  error={err(`${f.path}.mobileMediaId`)}
                />
                <TextField
                  label="Alt text"
                  maxLength={300}
                  value={String(getAt(value, `${f.path}.alt`) ?? "")}
                  onChange={(e) => set(`${f.path}.alt`, e.target.value)}
                  error={err(`${f.path}.alt`)}
                />
              </fieldset>
            );
          case "cta":
            return (
              <fieldset key={f.path} className="g-checklist" style={{ maxHeight: "none" }}>
                <legend>{f.label}</legend>
                <div className="form-grid">
                  <TextField
                    label={`${f.label} label`}
                    maxLength={60}
                    value={String(getAt(value, `${f.path}.label`) ?? "")}
                    onChange={(e) => set(`${f.path}.label`, e.target.value)}
                    error={err(`${f.path}.label`)}
                  />
                  <TextField
                    label={`${f.label} URL`}
                    maxLength={1000}
                    placeholder="/shop"
                    value={String(getAt(value, `${f.path}.url`) ?? "")}
                    onChange={(e) => set(`${f.path}.url`, e.target.value)}
                    error={err(`${f.path}.url`)}
                  />
                </div>
              </fieldset>
            );
          case "products":
            return (
              <ProductMultiPicker
                key={f.path}
                label={f.label}
                max={f.max}
                value={(getAt(value, f.path) as string[] | undefined) ?? []}
                onChange={(ids) => set(f.path, ids)}
              />
            );
          case "categories":
            return (
              <CategoryMultiPicker
                key={f.path}
                label={f.label}
                value={(getAt(value, f.path) as string[] | undefined) ?? []}
                onChange={(ids) => set(f.path, ids)}
              />
            );
          case "categorySelect":
            return (
              <SelectField
                key={f.path}
                label={f.label}
                value={String(getAt(value, f.path) ?? "")}
                onChange={(e) => set(f.path, e.target.value || undefined)}
                options={[{ value: "", label: "None" }, ...categoryOptions(cats.data?.items ?? [])]}
                error={err(f.path)}
              />
            );
          case "collectionSelect":
            return (
              <SelectField
                key={f.path}
                label={f.label}
                value={String(getAt(value, f.path) ?? "")}
                onChange={(e) => set(f.path, e.target.value || undefined)}
                options={[
                  { value: "", label: "None" },
                  ...(cols.data?.items ?? []).map((c) => ({ value: c.slug, label: c.name })),
                ]}
                error={err(f.path)}
              />
            );
        }
      })}
    </div>
  );
}

/** Short human summary of a stored section for the list. */
export function summarize(type: string, content: Content): string {
  const c = content ?? {};
  const pick = (c.heading ?? c.text ?? c.caption ?? c.html ?? c.body) as string | undefined;
  if (type === "CUSTOM_JSON") return `${Object.keys(c).length} key(s)`;
  return pick
    ? String(pick)
        .replace(/<[^>]+>/g, "")
        .slice(0, 80)
    : "";
}
