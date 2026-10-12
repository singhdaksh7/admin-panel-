import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { calls, lastCall, mockFetch, paginated, renderApp, type Handler } from "./growth-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const roles = {
  items: [
    {
      id: "r1",
      key: "SUPER_ADMIN",
      name: "Super Admin",
      description: "Full",
      isSystem: true,
      userCount: 1,
      permissions: ["users.read", "coupons.read"],
    },
    {
      id: "r2",
      key: "SUPPORT",
      name: "Support",
      description: null,
      isSystem: false,
      userCount: 0,
      permissions: ["coupons.read"],
    },
  ],
  allPermissions: ["coupons.read", "coupons.write", "users.read", "users.manage"],
};
const admins = [
  {
    id: "u1",
    email: "a@x.test",
    name: "Ada",
    isActive: true,
    lastLoginAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    roleId: "r1",
    role: { id: "r1", key: "SUPER_ADMIN", name: "Super Admin" },
  },
  {
    id: "u2",
    email: "b@x.test",
    name: "Bob",
    isActive: true,
    lastLoginAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    roleId: "r2",
    role: { id: "r2", key: "SUPPORT", name: "Support" },
  },
];
const sysApi: Handler = (_u, init, path) => {
  const method = init.method ?? "GET";
  if (path.startsWith("/users?")) return { body: paginated(admins) };
  if (path === "/roles" && method === "GET") return { body: roles };
  if (path === "/users" && method === "POST") return { status: 201, body: admins[1] };
  if (path === "/users/u1" && method === "PATCH")
    return {
      status: 409,
      body: { error: { code: "CONFLICT", message: "Cannot remove the last active Super Admin" } },
    };
  if (path === "/roles" && method === "POST") return { status: 201, body: { id: "r3", key: "X" } };
  return undefined;
};

describe("admin users", () => {
  it("is blocked without users.read", async () => {
    mockFetch(sysApi, ["dashboard.read"]);
    renderApp("/users");
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/users"))).toBe(false);
  });

  it("hides create/edit controls without users.manage", async () => {
    mockFetch(sysApi, ["users.read"]);
    renderApp("/users");
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New admin user" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deactivate/ })).not.toBeInTheDocument();
  });

  it("creates a user with role, temporary password and mustChangePassword", async () => {
    mockFetch(sysApi, ["users.read", "users.manage"]);
    renderApp("/users");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "New admin user" }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Create user" }));
    expect(await within(dialog).findByText("Enter a valid email address")).toBeInTheDocument();
    expect(within(dialog).getByText("Use at least 10 characters")).toBeInTheDocument();
    await u.type(within(dialog).getByLabelText("Email"), "new@x.test");
    await u.type(within(dialog).getByLabelText("Name"), "New Person");
    await u.selectOptions(await within(dialog).findByLabelText("Role"), "r2");
    await u.type(within(dialog).getByLabelText("Temporary password"), "Temp-pass-12345");
    await u.click(within(dialog).getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(lastCall("POST", "/users")).toBeTruthy());
    expect(lastCall("POST", "/users")!.body).toEqual({
      email: "new@x.test",
      name: "New Person",
      roleId: "r2",
      password: "Temp-pass-12345",
      mustChangePassword: true,
    });
  });

  it("surfaces the last-super-admin conflict when deactivating", async () => {
    mockFetch(sysApi, ["users.read", "users.manage"]);
    renderApp("/users");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Deactivate Ada" }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(
      await screen.findByText("Cannot remove the last active Super Admin"),
    ).toBeInTheDocument();
    expect(lastCall("PATCH", "/users/u1")!.body).toEqual({ isActive: false });
  });
});

describe("roles", () => {
  it("shows user counts, keeps system roles read-only and creates a custom role", async () => {
    mockFetch(sysApi, ["users.read", "roles.manage"]);
    renderApp("/roles");
    const u = userEvent.setup();
    expect(await screen.findByText("Super Admin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Super Admin" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Support" })).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "View Super Admin" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Role name")).toBeDisabled();
    await u.click(within(dialog).getByRole("button", { name: "Close" }));

    await u.click(screen.getByRole("button", { name: "New custom role" }));
    dialog = await screen.findByRole("dialog");
    await u.type(within(dialog).getByLabelText("Role name"), "Coupon Editor");
    const coupons = within(dialog).getByRole("group", { name: "coupons" });
    await u.click(within(coupons).getByLabelText("read"));
    await u.click(within(coupons).getByLabelText("write"));
    await u.click(within(dialog).getByRole("button", { name: "Create role" }));
    await waitFor(() => expect(lastCall("POST", "/roles")).toBeTruthy());
    expect(lastCall("POST", "/roles")!.body).toEqual({
      name: "Coupon Editor",
      permissions: ["coupons.read", "coupons.write"],
    });
  });
});

describe("audit logs", () => {
  it("filters by action and expands the JSON summary", async () => {
    mockFetch(
      (_u, _i, path) => {
        if (path.startsWith("/audit-logs"))
          return {
            body: paginated([
              {
                id: "a1",
                actorId: "u1",
                actorEmail: "a@x.test",
                action: "coupon.create",
                entityType: "Coupon",
                entityId: "c1",
                summary: { code: "SAVE10" },
                requestId: null,
                ip: "1.2.3.4",
                createdAt: "2026-01-01T10:00:00Z",
              },
            ]),
          };
        return undefined;
      },
      ["audit.read"],
    );
    renderApp("/audit-logs");
    const u = userEvent.setup();
    expect(await screen.findByText("coupon.create")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByLabelText("Audit summary")).toHaveTextContent('"code": "SAVE10"');
    await u.type(screen.getByLabelText("Filter by action"), "coupon");
    await waitFor(() => expect(calls.some((c) => c.path.includes("action=coupon"))).toBe(true));
  });
});

describe("integrations", () => {
  const items = [
    {
      kind: "PAYMENT",
      provider: "RAZORPAY",
      enabled: false,
      isActive: true,
      config: { mode: "test", capture: true, retries: 3 },
      secretsConfigured: { RAZORPAY_KEY_SECRET: true, RAZORPAY_KEY_ID: false },
    },
    {
      kind: "SHIPPING",
      provider: "MANUAL",
      enabled: true,
      isActive: false,
      config: {},
      secretsConfigured: {},
    },
  ];
  const intApi: Handler = (_u, init, path) => {
    const method = init.method ?? "GET";
    if (path === "/integrations" && method === "GET") return { body: { items } };
    if (path === "/integrations/PAYMENT/RAZORPAY" && method === "PUT") return { body: items[0] };
    return undefined;
  };

  it("saves only enabled + config, shows secret status and has no secret inputs", async () => {
    mockFetch(intApi, ["integrations.manage"]);
    const { container } = renderApp("/integrations");
    const u = userEvent.setup();
    await screen.findByText("RAZORPAY");
    expect(screen.getAllByText(/never shown or stored here/).length).toBeGreaterThan(0);
    expect(screen.getByText("RAZORPAY_KEY_SECRET")).toBeInTheDocument();
    expect(screen.getByText("configured: yes")).toBeInTheDocument();
    expect(screen.getByText("configured: no")).toBeInTheDocument();
    expect(screen.getByText("Active (set by environment)")).toBeInTheDocument();
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);

    await u.click(screen.getByLabelText("Enable RAZORPAY"));
    const mode = screen.getByLabelText("mode");
    await u.clear(mode);
    await u.type(mode, "live");
    await u.click(screen.getByRole("button", { name: "Save RAZORPAY" }));
    await waitFor(() => expect(lastCall("PUT", "/integrations/PAYMENT/RAZORPAY")).toBeTruthy());
    expect(lastCall("PUT", "/integrations/PAYMENT/RAZORPAY")!.body).toEqual({
      enabled: true,
      config: { mode: "live", capture: true, retries: 3 },
    });
  });

  it("refuses secret-looking config keys client-side", async () => {
    mockFetch(intApi, ["integrations.manage"]);
    renderApp("/integrations");
    const u = userEvent.setup();
    await screen.findByText("RAZORPAY");
    const name = screen.getAllByLabelText("New field name")[0]!;
    await u.type(name, "webhookSecret");
    await u.click(screen.getAllByRole("button", { name: "Add field" })[0]!);
    expect(await screen.findByText(/looks like a secret/)).toBeInTheDocument();
  });

  it("tolerates a missing endpoint and requires integrations.manage", async () => {
    mockFetch(() => undefined, ["integrations.manage"]);
    renderApp("/integrations");
    expect(await screen.findByText("Integrations are not available yet")).toBeInTheDocument();
    cleanup();
    mockFetch(intApi, ["settings.read"]);
    renderApp("/integrations");
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
  });
});
