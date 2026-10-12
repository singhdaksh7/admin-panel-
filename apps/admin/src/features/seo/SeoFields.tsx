import { CheckField, TextArea, TextField } from "../../components/ui";
import { ImageField, type FieldErrors } from "../media/shared";

/** Per-entity SEO block (pages, blog posts) matching the API `seoJson` shape. */
export interface SeoState {
  title: string;
  description: string;
  canonicalUrl: string;
  ogImageMediaId: string | null;
  noindex: boolean;
  nofollow: boolean;
}
export const EMPTY_SEO: SeoState = {
  title: "",
  description: "",
  canonicalUrl: "",
  ogImageMediaId: null,
  noindex: false,
  nofollow: false,
};

export function seoFromApi(s: Partial<SeoState> | null | undefined): SeoState {
  return {
    title: s?.title ?? "",
    description: s?.description ?? "",
    canonicalUrl: s?.canonicalUrl ?? "",
    ogImageMediaId: s?.ogImageMediaId ?? null,
    noindex: !!s?.noindex,
    nofollow: !!s?.nofollow,
  };
}

/** Returns the API object, or null when nothing is set. */
export function seoToApi(s: SeoState) {
  const out: Record<string, unknown> = {};
  if (s.title.trim()) out.title = s.title.trim();
  if (s.description.trim()) out.description = s.description.trim();
  if (s.canonicalUrl.trim()) out.canonicalUrl = s.canonicalUrl.trim();
  if (s.ogImageMediaId) out.ogImageMediaId = s.ogImageMediaId;
  if (s.noindex) out.noindex = true;
  if (s.nofollow) out.nofollow = true;
  return Object.keys(out).length ? out : null;
}

export function SeoFields({
  value,
  onChange,
  errors = {},
}: {
  value: SeoState;
  onChange: (s: SeoState) => void;
  errors?: FieldErrors;
}) {
  const set = <K extends keyof SeoState>(k: K, v: SeoState[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="g-stack">
      <TextField
        label="SEO title"
        maxLength={200}
        value={value.title}
        onChange={(e) => set("title", e.target.value)}
        error={errors["seo.title"]}
      />
      <TextArea
        label="Meta description"
        maxLength={500}
        value={value.description}
        onChange={(e) => set("description", e.target.value)}
        error={errors["seo.description"]}
      />
      <TextField
        label="Canonical URL"
        type="url"
        value={value.canonicalUrl}
        onChange={(e) => set("canonicalUrl", e.target.value)}
        error={errors["seo.canonicalUrl"]}
      />
      <ImageField
        label="Social share image"
        value={value.ogImageMediaId}
        onChange={(id) => set("ogImageMediaId", id)}
        error={errors["seo.ogImageMediaId"]}
      />
      <CheckField
        label="Hide from search engines (noindex)"
        checked={value.noindex}
        onChange={(e) => set("noindex", e.target.checked)}
      />
      <CheckField
        label="Do not follow links (nofollow)"
        checked={value.nofollow}
        onChange={(e) => set("nofollow", e.target.checked)}
      />
    </div>
  );
}
