import { vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes, makeQueryClient } from "../src/App";
import { AuthProvider } from "../src/auth/AuthContext";
import { ToastProvider } from "../src/components/ui";

export type Reply = { status?: number; body?: unknown } | undefined;
export type Handler = (url: string, init: RequestInit, path: string) => Reply;
export interface Call {
  url: string;
  path: string;
  method: string;
  body: unknown;
}
export const calls: Call[] = [];

/** Mock fetch. `path` passed to the handler is the part after /api/v1/admin (incl. query). */
export function mockFetch(handler: Handler, permissions: string[]) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.split("/api/v1/admin")[1] ?? url;
      const method = init.method ?? "GET";
      let body: unknown;
      try {
        body = init.body ? JSON.parse(init.body as string) : undefined;
      } catch {
        body = init.body;
      }
      calls.push({ url, path, method, body });
      let r: Reply;
      if (path === "/auth/me")
        r = {
          body: {
            user: {
              id: "u1",
              email: "a@x.test",
              name: "Ada",
              role: "ADMIN",
              permissions,
              csrfToken: "csrf",
            },
          },
        };
      else r = handler(url, init, path);
      r ??= { status: 404, body: { error: { code: "NOT_FOUND", message: "nope" } } };
      if (r.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

export function renderApp(path: string) {
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

export const paginated = <T,>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  totalPages: 1,
});

export const lastCall = (method: string, pathPrefix: string) =>
  [...calls].reverse().find((c) => c.method === method && c.path.startsWith(pathPrefix));
