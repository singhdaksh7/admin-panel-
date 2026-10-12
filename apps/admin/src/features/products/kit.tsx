/**
 * Small helpers shared by the operations screens (products, orders, ...): URL-synced list state,
 * API error mapping, money formatting, category tree flattening and a note/reason dialog.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../../lib/api";
import { useStoreSettings } from "../../lib/useStoreSettings";
import { useAuth } from "../../auth/AuthContext";
import { Button, EmptyState, Modal, TextArea, money, useDebounced } from "../../components/ui";
import "./ops.css";

/** Query-string backed state. Keys equal to their default are removed from the URL. */
export function useUrlParams<T extends Record<string, string>>(defaults: T) {
  const [sp, setSp] = useSearchParams();
  const values = useMemo(() => {
    const o: Record<string, string> = { ...defaults };
    for (const k of Object.keys(defaults)) {
      const v = sp.get(k);
      if (v !== null) o[k] = v;
    }
    return o as T;
  }, [sp, defaults]);
  const set = useCallback(
    (patch: Partial<T>) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === "" || v === defaults[k]) n.delete(k);
            else n.set(k, String(v));
          }
          if (!("page" in patch)) n.delete("page");
          return n;
        },
        { replace: true },
      );
    },
    [setSp, defaults],
  );
  return [values, set] as const;
}

/** Local text input that pushes a debounced value to the URL param. */
export function useUrlSearch(q: string, setQ: (v: string) => void): [string, (v: string) => void] {
  const [text, setText] = useState(q);
  const debounced = useDebounced(text, 300);
  useEffect(() => {
    if (debounced !== q) setQ(debounced);
  }, [debounced]);
  return [text, setText];
}

/** Store-currency money formatter. */
export function useMoney() {
  const s = useStoreSettings();
  const currency = s.data?.currency ?? "USD";
  const locale = s.data?.locale;
  return useCallback(
    (v: string | number | null | undefined, cur?: string) => money(v, cur ?? currency, locale),
    [currency, locale],
  );
}

/** Map an API failure to field errors (returns true when field errors were found) else toast it. */
export function applyApiError(
  err: unknown,
  setErrors: (e: Record<string, string>) => void,
  toast: { error(e: unknown): void },
): boolean {
  if (err instanceof ApiError) {
    const fe = err.fieldErrors();
    if (Object.keys(fe).length) {
      setErrors(fe);
      toast.error(new Error("Please fix the highlighted fields"));
      return true;
    }
  }
  toast.error(err);
  return false;
}

/** Banner listing API field errors that have no dedicated input. */
export function ErrorSummary({ errors }: { errors: Record<string, string> }) {
  const entries = Object.entries(errors);
  if (!entries.length) return null;
  return (
    <div className="alert-box" role="alert">
      <strong>Please fix the following</strong>
      <ul>
        {entries.map(([k, m]) => (
          <li key={k}>{k === "_" ? m : `${k}: ${m}`}</li>
        ))}
      </ul>
    </div>
  );
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  imageMediaId: string | null;
  bannerMediaId: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  seo: { title?: string; description?: string; noIndex?: boolean } | null;
  productCount: number;
  children: CategoryNode[];
}

export interface FlatCategory extends CategoryNode {
  depth: number;
  path: string;
  siblings: number;
  index: number;
}

export function flattenTree(nodes: CategoryNode[], depth = 0, prefix = ""): FlatCategory[] {
  const out: FlatCategory[] = [];
  nodes.forEach((n, index) => {
    const path = prefix ? `${prefix} / ${n.name}` : n.name;
    out.push({ ...n, depth, path, siblings: nodes.length, index });
    out.push(...flattenTree(n.children, depth + 1, path));
  });
  return out;
}

export function descendantIds(node: CategoryNode): string[] {
  return node.children.flatMap((c) => [c.id, ...descendantIds(c)]);
}

export const DECIMAL = /^\d{1,10}(\.\d{1,2})?$/;

/** Modal asking for a (possibly required) free-text note/reason. */
export function NoteDialog({
  title,
  message,
  label = "Note",
  required,
  confirmLabel = "Confirm",
  danger,
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  message?: ReactNode;
  label?: string;
  required?: boolean;
  confirmLabel?: string;
  danger?: boolean;
  onSubmit: (text: string) => Promise<unknown> | void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function go() {
    if (required && !text.trim()) {
      setErr(`${label} is required`);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(text.trim());
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={() => void go()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <p>{message}</p>}
      {children}
      <TextArea
        label={required ? label : `${label} (optional)`}
        value={text}
        rows={3}
        onChange={(e) => {
          setText(e.target.value);
          setErr(undefined);
        }}
        error={err}
      />
    </Modal>
  );
}

/** Human label for enum-ish strings. */
export const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase();

export function Thumb({ src, size = 40 }: { src?: string | null; size?: number }) {
  return src ? (
    <img className="ops-thumb" src={src} alt="" width={size} height={size} loading="lazy" />
  ) : (
    <div className="ops-thumb ops-thumb-empty" style={{ width: size, height: size }} aria-hidden />
  );
}

export function ListState({
  isLoading,
  isError,
  error,
  retry,
  empty,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  retry: () => void;
  empty?: ReactNode;
  children: ReactNode;
}) {
  if (isLoading)
    return (
      <div className="spinner" role="status">
        Loading…
      </div>
    );
  if (isError)
    return (
      <div className="error-state" role="alert">
        <strong>Could not load data</strong>
        <p>{error instanceof Error ? error.message : "Something went wrong"}</p>
        <Button onClick={retry}>Retry</Button>
      </div>
    );
  if (empty) return <>{empty}</>;
  return <>{children}</>;
}

/**
 * Route permission guard (same behaviour as the shell's Guard; duplicated here to avoid a
 * circular import between src/routes.tsx and the feature route modules).
 */
export function Guard({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const list = Array.isArray(perm) ? perm : [perm];
  if (!can(...list)) {
    return (
      <EmptyState
        title="Access denied"
        hint={`You need the ${list.join(", ")} permission to view this page.`}
      />
    );
  }
  return <>{children}</>;
}
