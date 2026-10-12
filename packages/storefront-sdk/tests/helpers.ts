import { createCommerceClient, createMemoryCartStorage, type CommerceClientOptions } from "../src";

export interface Call {
  url: string;
  path: string;
  search: URLSearchParams;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

export type Handler = (call: Call, n: number) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const apiError = (
  status: number,
  code: string,
  message = code,
  extra: { details?: unknown; requestId?: string } = {},
  headers: Record<string, string> = {},
) => json({ error: { code, message, ...extra } }, status, headers);

export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, "http://localhost");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const call: Call = {
      url,
      path: u.pathname,
      search: u.searchParams,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      init,
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

export function setup(handler: Handler, opts: Partial<CommerceClientOptions> = {}) {
  const f = fakeFetch(handler);
  const commerce = createCommerceClient({
    baseUrl: "http://api.test",
    fetch: f.fetch,
    cartStorage: createMemoryCartStorage(),
    retry: { retries: 2, baseDelayMs: 0 },
    ...opts,
  });
  return { commerce, ...f };
}

export const customer = {
  id: "c1",
  email: "a@b.co",
  firstName: null,
  lastName: null,
  phone: null,
  emailVerified: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

export const emptyCart = (token: string | null = null) => ({
  token,
  currency: "USD",
  items: [],
  itemCount: 0,
  subtotal: "0.00",
  discount: "0.00",
  tax: "0.00",
  taxInclusive: false,
  taxBreakdown: [],
  total: "0.00",
  shippingExcluded: true,
  couponCode: null,
  couponError: null,
  warnings: [],
});
