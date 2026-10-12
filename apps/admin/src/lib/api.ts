/**
 * Admin API client. Cookie session (httpOnly, set by the API) + per-session CSRF token header.
 * - Same-origin by default (VITE_API_URL empty => relative /api/... via dev proxy or nginx).
 * - On 401 it refreshes the session ONCE (single-flight) and replays the request.
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const PREFIX = `${BASE}/api/v1/admin`;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
  /** field -> message map from API validation errors */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code === "VALIDATION_ERROR" && Array.isArray(this.details)) {
      for (const d of this.details as { path: string; message: string }[])
        out[d.path || "_"] = d.message;
    }
    return out;
  }
}

let csrfToken: string | null = null;
let onSessionLost: (() => void) | null = null;
let refreshing: Promise<boolean> | null = null;

export function setCsrfToken(t: string | null) {
  csrfToken = t;
}
export function setSessionLostHandler(fn: (() => void) | null) {
  onSessionLost = fn;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export function toQuery(q?: Query): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } =
    {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const e = body.error;
  return new ApiError(
    res.status,
    e?.code ?? "HTTP_ERROR",
    e?.message ?? `Request failed (${res.status})`,
    e?.details,
    e?.requestId,
  );
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${PREFIX}/auth/refresh`, { method: "POST", credentials: "include" });
      if (!res.ok) return false;
      const body = (await res.json()) as { csrfToken: string };
      csrfToken = body.csrfToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function raw(
  method: string,
  path: string,
  body?: unknown,
  isForm = false,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (csrfToken && method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  return fetch(`${PREFIX}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isForm = false,
): Promise<T> {
  let res = await raw(method, path, body, isForm);
  const isAuthRoute = path.startsWith("/auth/login") || path.startsWith("/auth/refresh");
  if (res.status === 401 && !isAuthRoute) {
    if (await refreshSession()) res = await raw(method, path, body, isForm);
    if (res.status === 401) {
      onSessionLost?.();
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", `${path}${toQuery(query)}`),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T = { ok: true }>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, form, true),
  /** authenticated binary download (e.g. invoice PDF) -> object URL */
  async blobUrl(path: string): Promise<string> {
    const res = await raw("GET", path);
    if (!res.ok) throw await parseError(res);
    return URL.createObjectURL(await res.blob());
  },
};

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
