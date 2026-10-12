import { CommerceError, codeForStatus } from "./errors";
import { toSearchParams, type QueryParams } from "./query";
import { createDefaultCartStorage, type CartStorage } from "./storage";
import type { ApiErrorBody, AuthSession } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** extra attempts after the first for idempotent GETs (default 2). Never applies to POST/PUT/PATCH/DELETE. */
  retries?: number;
  /** base back-off in ms (default 250, exponential, honours Retry-After up to 5s) */
  baseDelayMs?: number;
}

export interface CommerceClientOptions {
  /** API origin, e.g. `https://api.shop.com`. `/api/v1` is appended unless already present. Use "" for same-origin proxies. */
  baseUrl: string;
  /** Inject a fetch implementation (tests, older runtimes, instrumented fetch). */
  fetch?: FetchLike;
  /** Cookie mode for the customer session (default `include`). Use `same-origin` behind a same-origin proxy if you prefer. */
  credentials?: RequestCredentials;
  /** Where the anonymous cart token is kept (default: localStorage if usable, else memory). */
  cartStorage?: CartStorage;
  /** Extra headers on every request (object or function, e.g. to forward cookies during SSR). */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Per-request timeout (default 15000). 0 disables. */
  timeoutMs?: number;
  /** Retry policy for idempotent GETs, or `false` to disable. */
  retry?: RetryOptions | false;
  /** Called when an authenticated call fails with 401 and the one-time session refresh also failed. */
  onUnauthorized?: (error: CommerceError) => void;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: QueryParams;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Customer-session call: send CSRF, refresh the session once on 401. */
  auth?: boolean;
  /** Send/refresh the cart token. */
  cart?: boolean;
  idempotencyKey?: string;
  /** Override retry (default: only GET retries). */
  retry?: boolean;
  /** @internal */
  _retried?: boolean;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_RETRY_AFTER_MS = 5000;

export const API_PREFIX = "/api/v1";

export function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith(API_PREFIX) ? trimmed : trimmed + API_PREFIX;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Shared transport: request building, errors, timeouts, retries, cart token and CSRF/session handling. */
export class Transport {
  readonly apiBase: string;
  private csrf: string | null = null;
  private cartToken: string | null | undefined;
  private refreshing: Promise<boolean> | null = null;
  private csrfLoading: Promise<void> | null = null;
  private readonly storage: CartStorage;
  private readonly fetchImpl: FetchLike;
  private readonly retryCfg: Required<RetryOptions> | false;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CommerceClientOptions) {
    if (typeof opts.baseUrl !== "string")
      throw new TypeError("createCommerceClient: baseUrl is required");
    this.apiBase = normalizeBase(opts.baseUrl);
    this.storage = opts.cartStorage ?? createDefaultCartStorage();
    this.fetchImpl =
      opts.fetch ??
      ((input, init) => {
        if (typeof globalThis.fetch !== "function")
          throw new Error("No global fetch available; pass `fetch` to createCommerceClient");
        return globalThis.fetch(input, init);
      });
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.retryCfg =
      opts.retry === false ? false : { retries: 2, baseDelayMs: 250, ...(opts.retry ?? {}) };
  }

  // ───────── cart token ─────────
  async getCartToken(): Promise<string | null> {
    if (this.cartToken === undefined) {
      try {
        this.cartToken = (await this.storage.get()) ?? null;
      } catch {
        this.cartToken = null;
      }
    }
    return this.cartToken;
  }
  async setCartToken(token: string): Promise<void> {
    this.cartToken = token;
    try {
      await this.storage.set(token);
    } catch {
      /* storage unavailable: memory copy still works for this session */
    }
  }
  async clearCartToken(): Promise<void> {
    this.cartToken = null;
    try {
      await this.storage.remove();
    } catch {
      /* ignore */
    }
  }

  // ───────── csrf / session ─────────
  getCsrfToken(): string | null {
    return this.csrf;
  }
  setCsrfToken(token: string | null): void {
    this.csrf = token;
  }
  storeSession(s: AuthSession): void {
    this.csrf = s.csrfToken;
  }

  /** URL builder (used for non-fetch resources such as the invoice PDF). */
  url(path: string, query?: QueryParams): string {
    const qs = toSearchParams(query);
    return this.apiBase + path + (qs ? `?${qs}` : "");
  }

  // ───────── main entry ─────────
  async request<T>(o: RequestOptions): Promise<T> {
    const method = o.method ?? "GET";
    if (o.auth && UNSAFE.has(method) && !this.csrf) await this.loadCsrf();
    try {
      return await this.withRetry<T>(o);
    } catch (e) {
      if (!(e instanceof CommerceError)) throw e;
      if (o.auth && !o._retried) {
        if (e.status === 401) {
          if (await this.refreshSession()) return this.request<T>({ ...o, _retried: true });
          this.csrf = null;
          this.opts.onUnauthorized?.(e);
        } else if (e.code === "CSRF_FAILED") {
          this.csrf = null;
          await this.loadCsrf(true);
          if (this.csrf) return this.request<T>({ ...o, _retried: true });
        }
      } else if (e.status === 401 && o.auth) {
        this.opts.onUnauthorized?.(e);
      }
      throw e;
    }
  }

  /** `POST /account/refresh` once (single-flight). Resolves false when no valid session exists. */
  refreshSession(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const s = await this.withRetry<AuthSession>({
          method: "POST",
          path: "/account/refresh",
          retry: false,
        });
        this.csrf = s.csrfToken;
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private loadCsrf(force = false): Promise<void> {
    if (this.csrf && !force) return Promise.resolve();
    this.csrfLoading ??= (async () => {
      try {
        const s = await this.withRetry<AuthSession>({ path: "/account/me" });
        this.csrf = s.csrfToken;
      } catch {
        /* not signed in (or session expired): the real call will surface 401 */
      } finally {
        this.csrfLoading = null;
      }
    })();
    return this.csrfLoading;
  }

  // ───────── retry + single attempt ─────────
  private async withRetry<T>(o: RequestOptions): Promise<T> {
    const method = o.method ?? "GET";
    const canRetry = method === "GET" && o.retry !== false && this.retryCfg !== false;
    const retries = canRetry ? (this.retryCfg as Required<RetryOptions>).retries : 0;
    const base = this.retryCfg === false ? 0 : this.retryCfg.baseDelayMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt<T>(o);
      } catch (e) {
        if (
          !(e instanceof CommerceError) ||
          attempt >= retries ||
          !e.isRetryable ||
          e.code === "ABORTED"
        )
          throw e;
        const backoff = base * 2 ** attempt + Math.floor(Math.random() * (base / 2 + 1));
        const wait =
          e.retryAfterMs !== undefined ? Math.min(e.retryAfterMs, MAX_RETRY_AFTER_MS) : backoff;
        await sleep(wait);
      }
    }
  }

  private async attempt<T>(o: RequestOptions): Promise<T> {
    const method = o.method ?? "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    const extra = typeof this.opts.headers === "function" ? this.opts.headers() : this.opts.headers;
    Object.assign(headers, extra, o.headers);
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (o.cart) {
      const t = await this.getCartToken();
      if (t) headers["X-Cart-Token"] = t;
    }
    if (UNSAFE.has(method) && this.csrf) headers["X-CSRF-Token"] = this.csrf;
    if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;

    const url = this.url(o.path, o.query);
    const init: RequestInit = {
      method,
      headers,
      credentials: this.opts.credentials ?? "include",
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    };

    const ctrl = new AbortController();
    init.signal = ctrl.signal;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUserAbort = () => ctrl.abort();
    if (o.signal) {
      if (o.signal.aborted) ctrl.abort();
      else o.signal.addEventListener("abort", onUserAbort, { once: true });
    }
    const timeout = new Promise<never>((_, reject) => {
      if (this.timeoutMs > 0 && Number.isFinite(this.timeoutMs)) {
        timer = setTimeout(() => {
          timedOut = true;
          ctrl.abort();
          reject(new Error("timeout"));
        }, this.timeoutMs);
      }
    });
    timeout.catch(() => undefined); // avoid unhandled rejection when the request wins the race

    try {
      const work = (async () => {
        const res = await this.fetchImpl(url, init);
        const text = await res.text();
        return { res, text };
      })();
      work.catch(() => undefined);
      const { res, text } = await Promise.race([work, timeout]);
      return await this.parse<T>(res, text, o);
    } catch (e) {
      if (e instanceof CommerceError) throw e;
      if (timedOut)
        throw new CommerceError({
          status: 0,
          code: "TIMEOUT",
          message: `Request timed out after ${this.timeoutMs}ms`,
          cause: e,
        });
      if (o.signal?.aborted || (e as { name?: string })?.name === "AbortError")
        throw new CommerceError({
          status: 0,
          code: "ABORTED",
          message: "Request aborted",
          cause: e,
        });
      throw new CommerceError({
        status: 0,
        code: "NETWORK_ERROR",
        message: "Network request failed",
        cause: e,
      });
    } finally {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onUserAbort);
    }
  }

  private async parse<T>(res: Response, text: string, o: RequestOptions): Promise<T> {
    let data: unknown;
    let parsed = false;
    if (text) {
      try {
        data = JSON.parse(text);
        parsed = true;
      } catch {
        /* non-JSON body */
      }
    }
    const requestId = res.headers?.get?.("x-request-id") ?? undefined;
    if (!res.ok) {
      const body = (parsed ? data : undefined) as Partial<ApiErrorBody> | undefined;
      const err = body && typeof body === "object" ? body.error : undefined;
      const ra = Number(res.headers?.get?.("retry-after"));
      throw new CommerceError({
        status: res.status,
        code: err?.code ?? codeForStatus(res.status),
        message: err?.message ?? (res.statusText || `HTTP ${res.status}`),
        details: err?.details ?? (parsed || !text ? undefined : { body: text.slice(0, 200) }),
        requestId: err?.requestId ?? requestId,
        retryAfterMs:
          Number.isFinite(ra) && ra >= 0 && res.headers.get("retry-after") ? ra * 1000 : undefined,
      });
    }
    if (!text) return undefined as T;
    if (!parsed)
      throw new CommerceError({
        status: res.status,
        code: "INVALID_RESPONSE",
        message: "The server returned a non-JSON response",
        details: { body: text.slice(0, 200) },
        requestId,
      });
    if (o.cart && data && typeof data === "object" && "token" in data) {
      const token = (data as { token: unknown }).token;
      if (typeof token === "string" && token) await this.setCartToken(token);
    }
    return data as T;
  }
}
