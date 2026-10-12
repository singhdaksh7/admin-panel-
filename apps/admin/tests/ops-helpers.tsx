import { vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes, makeQueryClient } from "../src/App";
import { AuthProvider } from "../src/auth/AuthContext";
import { ToastProvider } from "../src/components/ui";
import { setCsrfToken } from "../src/lib/api";

export interface Reply {
  status?: number;
  body?: unknown;
}
export type RouteTable = Record<string, Reply | ((req: { url: string; body: unknown }) => Reply)>;
export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export let calls: Call[] = [];

const PREFIX = "/api/v1/admin";

/** Route keys look like "GET /products" (path without query string). */
export function mockApi(table: RouteTable) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const [rawPath, qs] = url.replace(PREFIX, "").split("?");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: rawPath!, query: new URLSearchParams(qs), body });
      const hit = table[`${method} ${rawPath}`];
      const r: Reply = (typeof hit === "function" ? hit({ url, body }) : hit) ?? {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "nope" } },
      };
      if (r.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

export const callsTo = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

export const ADMIN_PERMS = [
  "dashboard.read",
  "products.read",
  "products.write",
  "categories.read",
  "categories.write",
  "collections.write",
  "attributes.write",
  "inventory.read",
  "inventory.write",
  "media.read",
  "media.write",
  "orders.read",
  "orders.update",
  "returns.read",
  "returns.manage",
  "customers.read",
  "customers.write",
];
export const READ_ONLY_PERMS = ADMIN_PERMS.filter((p) => p.endsWith(".read"));

export function renderAt(path: string, perms: string[], table: RouteTable) {
  setCsrfToken(null);
  mockApi({
    "GET /auth/me": {
      body: {
        user: {
          id: "u1",
          email: "a@x.test",
          name: "Ada",
          role: "ADMIN",
          permissions: perms,
          csrfToken: "csrf",
        },
      },
    },
    "GET /settings": { body: { name: "S", currency: "USD", locale: "en-US" } },
    ...table,
  });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

export const page = <T,>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  totalPages: 1,
});
