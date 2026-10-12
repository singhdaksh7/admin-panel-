import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes, makeQueryClient } from "../src/App";
import { AuthProvider } from "../src/auth/AuthContext";
import { ToastProvider } from "../src/components/ui";
import { api, setCsrfToken } from "../src/lib/api";
import { Guard } from "../src/routes";

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;
let calls: { url: string; init: RequestInit }[] = [];

function mockFetch(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const r = handler(url, init) ?? {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "nope" } },
      };
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const summary = {
  currency: "USD",
  revenue: {
    today: { revenue: "10.00", orders: 1 },
    last7Days: { revenue: "10.00", orders: 1 },
    last30Days: { revenue: "10.00", orders: 1 },
  },
  ordersByStatus: { PENDING: 1 },
  lowStock: [],
  topProducts: [],
  recentOrders: [],
  alerts: { pendingUnpaidOrders: 0, lowStockVariants: 0, outOfStockVariants: 0 },
};
const user = (permissions: string[], role = "ADMIN") => ({
  id: "u1",
  email: "a@x.test",
  name: "Ada",
  role,
  permissions,
  csrfToken: "csrf-1",
});

function renderApp(path = "/") {
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

beforeEach(() => setCsrfToken(null));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authentication", () => {
  it("redirects unauthenticated visitors to the login form", async () => {
    mockFetch((url) =>
      url.endsWith("/auth/me")
        ? { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } }
        : undefined,
    );
    renderApp("/products");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("signs in, shows the dashboard, and shows API errors on bad credentials", async () => {
    let attempt = 0;
    mockFetch((url) => {
      if (url.endsWith("/auth/me"))
        return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } };
      if (url.endsWith("/auth/login")) {
        attempt++;
        return attempt === 1
          ? {
              status: 401,
              body: { error: { code: "UNAUTHENTICATED", message: "Invalid email or password" } },
            }
          : { body: { user: user(["dashboard.read"]), csrfToken: "csrf-1" } };
      }
      if (url.includes("/dashboard/summary")) return { body: summary };
    });
    renderApp("/");
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Email"), "a@x.test");
    await u.type(screen.getByLabelText("Password"), "wrong-password");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });
});

describe("permission gates", () => {
  it("only lists navigation entries the admin may use", async () => {
    mockFetch((url) => {
      if (url.endsWith("/auth/me"))
        return { body: { user: user(["dashboard.read", "orders.read"], "ORDER_MANAGER") } };
      if (url.includes("/dashboard/summary")) return { body: summary };
    });
    renderApp("/");
    const nav = await screen.findByRole("navigation");
    await waitFor(() => expect(nav).toHaveTextContent("Orders"));
    expect(nav).not.toHaveTextContent("Products");
    expect(nav).not.toHaveTextContent("Admin Users");
    expect(nav).not.toHaveTextContent("Integrations");
  });

  it("Guard blocks a page when a permission is missing", async () => {
    mockFetch((url) =>
      url.endsWith("/auth/me") ? { body: { user: user(["dashboard.read"]) } } : undefined,
    );
    render(
      <AuthProvider>
        <Guard perm="users.manage">
          <p>secret page</p>
        </Guard>
      </AuthProvider>,
    );
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(screen.queryByText("secret page")).not.toBeInTheDocument();
  });
});

describe("api client", () => {
  it("sends the CSRF token on mutations and not on reads", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    setCsrfToken("tok-123");
    await api.get("/products");
    await api.post("/products", { a: 1 });
    expect((calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok-123");
    expect(calls[1]!.init.credentials).toBe("include");
  });

  it("refreshes the session once on 401 and replays the request", async () => {
    let first = true;
    mockFetch((url) => {
      if (url.endsWith("/auth/refresh")) return { body: { csrfToken: "fresh" } };
      if (url.endsWith("/orders")) {
        if (first) {
          first = false;
          return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "expired" } } };
        }
        return { body: { items: [] } };
      }
    });
    const r = await api.get<{ items: unknown[] }>("/orders");
    expect(r.items).toEqual([]);
    expect(calls.map((c) => c.url.split("/admin")[1])).toEqual([
      "/orders",
      "/auth/refresh",
      "/orders",
    ]);
  });

  it("maps validation errors to field messages", async () => {
    mockFetch(() => ({
      status: 422,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details: [{ path: "title", message: "Required" }],
        },
      },
    }));
    await expect(api.post("/products", {})).rejects.toMatchObject({ status: 422 });
    try {
      await api.post("/products", {});
    } catch (e) {
      expect((e as { fieldErrors(): Record<string, string> }).fieldErrors()).toEqual({
        title: "Required",
      });
    }
  });
});
