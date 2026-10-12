import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Button,
  Card,
  ErrorState,
  PageHeader,
  SelectField,
  Spinner,
  TextArea,
  TextField,
  useToast,
} from "../../components/ui";
import { ImageField, handleSaveError, type FieldErrors } from "../media/shared";

export interface SeoDefaults {
  titleTemplate: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultOgImageMediaId: string | null;
  robots: "index" | "noindex";
  siteUrl: string | null;
}

export function Seo() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canWrite = can("seo.write");
  const [f, setF] = useState<SeoDefaults | null>(null);
  const [base, setBase] = useState<SeoDefaults | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["seo-defaults"], queryFn: () => api.get<SeoDefaults>("/seo") });
  useEffect(() => {
    if (q.data) {
      setF(q.data);
      setBase(q.data);
    }
  }, [q.data]);

  if (!f || !base)
    return q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : <Spinner />;
  const set = (p: Partial<SeoDefaults>) => setF({ ...f, ...p });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f || !base) return;
    const errs: FieldErrors = {};
    if (!f.titleTemplate.includes("%s"))
      errs.titleTemplate = "Must contain %s (replaced by the page title)";
    if (f.siteUrl) {
      try {
        const u = new URL(f.siteUrl);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        errs.siteUrl = "Enter a full URL such as https://shop.example.com";
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body: Partial<SeoDefaults> = {};
    for (const k of Object.keys(f) as (keyof SeoDefaults)[]) {
      if (f[k] !== base[k])
        (body as Record<string, unknown>)[k] = k === "siteUrl" ? f.siteUrl || null : f[k];
    }
    if (!Object.keys(body).length) {
      toast.success("No changes to save");
      return;
    }
    setBusy(true);
    try {
      const saved = await api.put<SeoDefaults>("/seo", body);
      setF(saved);
      setBase(saved);
      toast.success("SEO defaults saved");
      void qc.invalidateQueries({ queryKey: ["seo-defaults"] });
    } catch (err) {
      handleSaveError(err, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="SEO"
        subtitle="Store-wide defaults used when a page, post or product has no SEO of its own"
      />
      <form onSubmit={submit} noValidate className="g-stack">
        <fieldset
          disabled={!canWrite}
          style={{ border: 0, padding: 0, margin: 0 }}
          className="g-stack"
        >
          <Card title="Search results">
            <div className="g-stack">
              <TextField
                label="Title template"
                value={f.titleTemplate}
                onChange={(e) => set({ titleTemplate: e.target.value })}
                error={errors.titleTemplate}
                hint="Use %s for the page title, e.g. %s | My Store"
                maxLength={120}
              />
              <TextField
                label="Default title"
                value={f.defaultTitle}
                onChange={(e) => set({ defaultTitle: e.target.value })}
                error={errors.defaultTitle}
                maxLength={200}
              />
              <TextArea
                label="Default description"
                value={f.defaultDescription}
                onChange={(e) => set({ defaultDescription: e.target.value })}
                error={errors.defaultDescription}
                maxLength={500}
              />
              <ImageField
                label="Default social share image"
                value={f.defaultOgImageMediaId}
                onChange={(id) => set({ defaultOgImageMediaId: id })}
                error={errors.defaultOgImageMediaId}
              />
            </div>
          </Card>
          <Card title="Indexing">
            <div className="form-grid">
              <SelectField
                label="Search engine visibility"
                value={f.robots}
                onChange={(e) => set({ robots: e.target.value as SeoDefaults["robots"] })}
                options={[
                  { value: "index", label: "Allow indexing" },
                  { value: "noindex", label: "Hide entire site (noindex)" },
                ]}
                error={errors.robots}
                hint={
                  f.robots === "noindex"
                    ? "Use only for staging or while building the store"
                    : undefined
                }
              />
              <TextField
                label="Site URL"
                type="url"
                placeholder="https://shop.example.com"
                value={f.siteUrl ?? ""}
                onChange={(e) => set({ siteUrl: e.target.value })}
                error={errors.siteUrl}
                hint="Used for absolute URLs and structured data"
              />
            </div>
          </Card>
        </fieldset>
        {canWrite && (
          <div className="g-actions">
            <Button variant="primary" type="submit" loading={busy}>
              Save SEO defaults
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
