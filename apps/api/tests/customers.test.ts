import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import {
  PW,
  addToCart,
  addr,
  checkout,
  loginCustomer,
  registerCustomer,
  seedProduct,
} from "./commerceHelpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
beforeAll(async () => {
  ({ app } = await bootApp());
});

describe("customer auth", () => {
  it("registers, sets httpOnly cookie, never returns hashes, sends welcome mail", async () => {
    const res = await request(app)
      .post("/api/v1/account/register")
      .send({ email: "New@Example.com", password: PW, firstName: "Nia" });
    expect(res.status).toBe(201);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/kc_customer=.*HttpOnly/i);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/Path=\/api\/v1/);
    expect(res.body.customer.email).toBe("new@example.com");
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
    const log = await prisma.notificationLog.findFirst({ where: { event: "customer.welcome" } });
    expect(log?.recipient).toBe("new@example.com");
  });

  it("rejects weak passwords and duplicate emails", async () => {
    const weak = await request(app).post("/api/v1/account/register").send({ email: "w@example.com", password: "short" });
    expect(weak.status).toBe(422);
    const dup = await request(app).post("/api/v1/account/register").send({ email: "new@example.com", password: PW });
    expect(dup.status).toBe(409);
  });

  it("login is generic on failure, works on success, and /me needs the session", async () => {
    expect((await request(app).get("/api/v1/account/me")).status).toBe(401);
    const bad = await request(app).post("/api/v1/account/login").send({ email: "new@example.com", password: "wrong-password-1" });
    const unknown = await request(app).post("/api/v1/account/login").send({ email: "nobody@example.com", password: "wrong-password-1" });
    expect(bad.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message);
    const c = await loginCustomer(app, "new@example.com");
    const me = await c.get("/api/v1/account/me");
    expect(me.status).toBe(200);
    expect(me.body.customer.firstName).toBe("Nia");
  });

  it("requires the CSRF header on unsafe account calls", async () => {
    const c = await loginCustomer(app, "new@example.com");
    const noCsrf = await c.agent.patch("/api/v1/account/me").send({ lastName: "X" });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("CSRF_FAILED");
    const wrong = await c.agent.patch("/api/v1/account/me").set("x-csrf-token", "nope").send({ lastName: "X" });
    expect(wrong.status).toBe(403);
    expect((await c.patch("/api/v1/account/me", { lastName: "Sharma" })).body.customer.lastName).toBe("Sharma");
  });

  it("rotates refresh tokens and revokes the family when a rotated token is replayed", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/v1/account/login").send({ email: "new@example.com", password: PW });
    const oldCookie = login.headers["set-cookie"]![0]!.split(";")[0]!;
    const refreshed = await agent.post("/api/v1/account/refresh");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.csrfToken).not.toBe(login.body.csrfToken);
    expect((await agent.get("/api/v1/account/me")).status).toBe(200);
    const replay = await request(app).post("/api/v1/account/refresh").set("Cookie", oldCookie);
    expect(replay.status).toBe(401);
    expect((await agent.get("/api/v1/account/me")).status).toBe(401);
  });

  it("logout revokes the session (needs CSRF)", async () => {
    const c = await loginCustomer(app, "new@example.com");
    expect((await c.agent.post("/api/v1/account/logout")).status).toBe(403);
    expect((await c.post("/api/v1/account/logout")).status).toBe(200);
    expect((await c.get("/api/v1/account/me")).status).toBe(401);
  });

  it("backs off after repeated failed logins", async () => {
    await registerCustomer(app, "lock@example.com");
    for (let i = 0; i < 5; i++)
      await request(app).post("/api/v1/account/login").send({ email: "lock@example.com", password: "bad-password-xx" });
    const locked = await request(app).post("/api/v1/account/login").send({ email: "lock@example.com", password: PW });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("changes password and revokes other sessions", async () => {
    const a = await registerCustomer(app, "pw@example.com");
    const b = await loginCustomer(app, "pw@example.com");
    const bad = await a.post("/api/v1/account/change-password", { currentPassword: "nope-nope-nope", newPassword: "Another-Pass-9" });
    expect(bad.status).toBe(422);
    expect((await a.post("/api/v1/account/change-password", { currentPassword: PW, newPassword: "Another-Pass-9" })).status).toBe(200);
    expect((await a.get("/api/v1/account/me")).status).toBe(200);
    expect((await b.get("/api/v1/account/me")).status).toBe(401);
    expect((await loginCustomer(app, "pw@example.com", "Another-Pass-9")).id).toBe(a.id);
  });
});

describe("password reset", () => {
  it("is non-enumerating, single-use, and revokes sessions", async () => {
    const c = await registerCustomer(app, "reset@example.com");
    const known = await request(app).post("/api/v1/account/forgot-password").send({ email: "reset@example.com" });
    const unknown = await request(app).post("/api/v1/account/forgot-password").send({ email: "ghost@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(await prisma.notificationLog.count({ where: { event: "password.reset", recipient: "reset@example.com" } })).toBe(1);
    expect(await prisma.notificationLog.count({ where: { recipient: "ghost@example.com" } })).toBe(0);

    // the raw token only exists in the email: plant a known one
    const { sha256 } = await import("../src/lib/crypto");
    const raw = "r".repeat(40);
    await prisma.customerPasswordReset.create({
      data: { customerId: c.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 60_000) },
    });
    const ok = await request(app).post("/api/v1/account/reset-password").send({ token: raw, newPassword: "Brand-New-Pass-1" });
    expect(ok.status).toBe(200);
    expect((await request(app).post("/api/v1/account/reset-password").send({ token: raw, newPassword: "Brand-New-Pass-2" })).status).toBe(400);
    expect((await c.get("/api/v1/account/me")).status).toBe(401);
    expect((await loginCustomer(app, "reset@example.com", "Brand-New-Pass-1")).id).toBe(c.id);
  });
});

describe("addresses + IDOR", () => {
  it("CRUDs addresses with default handling and isolates customers", async () => {
    const a = await registerCustomer(app, "addr-a@example.com");
    const b = await registerCustomer(app, "addr-b@example.com");
    const first = await a.post("/api/v1/account/addresses", addr());
    expect(first.status).toBe(201);
    expect(first.body.isDefaultShipping).toBe(true);
    const second = await a.post("/api/v1/account/addresses", addr({ line1: "2 Park St", isDefaultShipping: true }));
    expect(second.body.isDefaultShipping).toBe(true);
    const list = await a.get("/api/v1/account/addresses");
    expect(list.body.items.filter((x: { isDefaultShipping: boolean }) => x.isDefaultShipping)).toHaveLength(1);

    // b cannot see/modify/delete a's address
    expect((await b.get("/api/v1/account/addresses")).body.items).toHaveLength(0);
    expect((await b.patch(`/api/v1/account/addresses/${first.body.id}`, { city: "Hacked" })).status).toBe(404);
    expect((await b.del(`/api/v1/account/addresses/${first.body.id}`)).status).toBe(404);
    expect((await prisma.address.findUniqueOrThrow({ where: { id: first.body.id } })).city).toBe("Bengaluru");

    expect((await a.patch(`/api/v1/account/addresses/${first.body.id}`, { city: "Mysuru" })).body.city).toBe("Mysuru");
    expect((await a.del(`/api/v1/account/addresses/${first.body.id}`)).status).toBe(200);
  });
});

describe("orders + guest merge", () => {
  it("links guest orders on registration and only lists own orders", async () => {
    const { variant } = await seedProduct({ stock: 20 });
    const token = await addToCart(app, variant.id, 1);
    const guest = await checkout(app, token, { email: "guest@example.com", paymentProvider: "MANUAL" });
    expect(guest.status).toBe(201);
    const orderNumber = guest.body.order.orderNumber as string;
    expect((await prisma.order.findUniqueOrThrow({ where: { orderNumber } })).customerId).toBeNull();

    const g = await registerCustomer(app, "guest@example.com");
    const other = await registerCustomer(app, "other@example.com");
    const mine = await g.get("/api/v1/account/orders");
    expect(mine.body.items.map((o: { orderNumber: string }) => o.orderNumber)).toContain(orderNumber);
    expect((await g.get(`/api/v1/account/orders/${orderNumber}`)).status).toBe(200);
    // IDOR: another customer gets 404, and sees nothing in their list
    expect((await other.get(`/api/v1/account/orders/${orderNumber}`)).status).toBe(404);
    expect((await other.get("/api/v1/account/orders")).body.items).toHaveLength(0);
  });
});

describe("feature flag + admin", () => {
  it("returns 403 on /account/* when customerAccounts is disabled, guest checkout still works", async () => {
    const admin = await loginAdmin(app);
    await admin.put("/api/v1/admin/settings", { features: { customerAccounts: false } });
    expect((await request(app).post("/api/v1/account/register").send({ email: "off@example.com", password: PW })).status).toBe(403);
    expect((await request(app).post("/api/v1/account/login").send({ email: "off@example.com", password: PW })).status).toBe(403);
    const { variant } = await seedProduct();
    const token = await addToCart(app, variant.id, 1);
    expect((await checkout(app, token, { paymentProvider: "MANUAL" })).status).toBe(201);
    await admin.put("/api/v1/admin/settings", { features: { customerAccounts: true } });
  });

  it("admin lists/searches/gets/deactivates customers with permission checks", async () => {
    const c = await registerCustomer(app, "adm-target@example.com");
    const admin = await loginAdmin(app);
    const list = await admin.get("/api/v1/admin/customers?q=adm-target");
    expect(list.body.items).toHaveLength(1);
    const detail = await admin.get(`/api/v1/admin/customers/${c.id}`);
    expect(detail.body.ordersSummary).toMatchObject({ count: 0 });

    await createAdminWithRole("CATALOG_MANAGER", "cat@test.example");
    const cat = await loginAdmin(app, "cat@test.example", "Another-Pass-123");
    expect((await cat.get("/api/v1/admin/customers")).status).toBe(403);
    await createAdminWithRole("ORDER_MANAGER", "om@test.example");
    const om = await loginAdmin(app, "om@test.example", "Another-Pass-123");
    expect((await om.get("/api/v1/admin/customers")).status).toBe(200);
    expect((await om.patch(`/api/v1/admin/customers/${c.id}`, { isActive: false })).status).toBe(403);

    expect((await admin.patch(`/api/v1/admin/customers/${c.id}`, { isActive: false })).body.isActive).toBe(false);
    expect((await c.get("/api/v1/account/me")).status).toBe(401);
    expect((await request(app).post("/api/v1/account/login").send({ email: "adm-target@example.com", password: PW })).status).toBe(401);
  });
});
