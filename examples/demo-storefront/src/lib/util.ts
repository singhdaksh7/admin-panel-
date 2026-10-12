import { useCallback, useEffect, useRef, useState } from "react";
import { CommerceError } from "@kash-commerce/storefront-sdk";

export function errorMessage(e: unknown): string {
  if (e instanceof CommerceError) {
    const fields = e.fieldErrors();
    if (fields.length) return `${e.message}: ${fields.map((f) => f.message).join("; ")}`;
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
}

/** Tiny data-loading hook: re-runs when `deps` change, ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fnRef
      .current()
      .then((data) => alive && setState({ data, error: undefined, loading: false }))
      .catch((error: unknown) => alive && setState({ data: undefined, error, loading: false }));
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function isNotFound(e: unknown): boolean {
  return e instanceof CommerceError && e.isNotFound();
}

/** Set the document title for the current view. */
export function useTitle(title: string | undefined, suffix?: string) {
  useEffect(() => {
    if (!title) return;
    document.title = suffix ? `${title} | ${suffix}` : title;
  }, [title, suffix]);
}
