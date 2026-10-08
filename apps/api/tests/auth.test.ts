import { beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootApp,
  createAdminWithRole,
  loginAdmin,
  prisma,
  request,
} from "./helpers";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
beforeAll(async () => {
  ({ app } = await bootApp());
});

describe("health", () => {
  it("reports health and readiness (DB checked)", async () => {
    expect((await request(app).get("/api/health")).body.status).toBe("ok");
    const ready = await request(app).get("/api/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.database).toBe("ok");
  });
});

describe("admin auth", () => {
  it("rejects unauthenticated access and bad credentials generically", async () => {
    expect((await request(app).get("/api/v1/admin/auth/me")).status).toBe(401);
    const bad = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email: ADMIN_EMAIL, password: "nope-nope" });
    expect(bad.status).toBe(401);
    const unknown = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email: "who@x.example", password: "nope-nope" });
    expect(unknown.body.error.message).toBe(bad.body.error.message);
  });

  it("logs in with httpOnly cookie, returns permissions, never the hash", async () => {
    const res = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/i);
    expect(res.body.user.role).toBe("SUPER_ADMIN");
    expect(res.body.user.permissions).toContain("users.manage");
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it("requires CSRF header on unsafe methods", async () => {
    const s = await loginAdmin(app);
    const noCsrf = await s.agent.put("/api/v1/admin/settings").send({ name: "X" });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("CSRF_FAILED");
    const wrong = await s.agent
      .put("/api/v1/admin/settings")
      .set("x-csrf-token", "wrong")
      .send({ name: "X" });
    expect(wrong.status).toBe(403);
    expect((await s.put("/api/v1/admin/settings", { name: "Shop A" })).status).toBe(200);
  });

  it("rotates sessions and kills the family when a rotated token is replayed", async () => {
    const agent = request.agent(app);
    const login = await agent
      .post("/api/v1/admin/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const oldCookie = login.headers["set-cookie"]![0]!.split(";")[0]!;
    const refreshed = await agent.post("/api/v1/admin/auth/refresh");
    expect(refreshed.status).toBe(200);
    expect((await agent.get("/api/v1/admin/auth/me")).status).toBe(200);
    // replay the OLD token
    const replay = await request(app).post("/api/v1/admin/auth/refresh").set("Cookie", oldCookie);
    expect(replay.status).toBe(401);
    // family revoked -> the new token no longer works either
    expect((await agent.get("/api/v1/admin/auth/me")).status).toBe(401);
  });

  it("locks the account after repeated failures", async () => {
    await createAdminWithRole("SUPPORT", "lock@test.example");
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/v1/admin/auth/login")
        .send({ email: "lock@test.example", password: "wrong-wrong-1" });
    }
    const res = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email: "lock@test.example", password: "Another-Pass-123" });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("changes password, revokes other sessions, and enforces policy", async () => {
    await createAdminWithRole("ADMIN", "pw@test.example");
    const a = await loginAdmin(app, "pw@test.example", "Another-Pass-123");
    const b = await loginAdmin(app, "pw@test.example", "Another-Pass-123");
    expect(
      (
        await a.post("/api/v1/admin/auth/change-password", {
          currentPassword: "Another-Pass-123",
          newPassword: "short",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await a.post("/api/v1/admin/auth/change-password", {
          currentPassword: "bad",
          newPassword: "Brand-New-Pass-9",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await a.post("/api/v1/admin/auth/change-password", {
          currentPassword: "Another-Pass-123",
          newPassword: "Brand-New-Pass-9",
        })
      ).status,
    ).toBe(200);
    expect((await b.get("/api/v1/admin/auth/me")).status).toBe(401);
    expect((await a.get("/api/v1/admin/auth/me")).status).toBe(200);
    await loginAdmin(app, "pw@test.example", "Brand-New-Pass-9");
  });

  it("forgot/reset password is non-enumerating and single-use", async () => {
    await createAdminWithRole("ADMIN", "reset@test.example");
    expect(
      (
        await request(app)
          .post("/api/v1/admin/auth/forgot-password")
          .send({ email: "nobody@x.example" })
      ).body.ok,
    ).toBe(true);
    expect(
      (
        await request(app)
          .post("/api/v1/admin/auth/forgot-password")
          .send({ email: "reset@test.example" })
      ).body.ok,
    ).toBe(true);
    // token is only delivered by email; craft a known one for the test
    const user = await prisma.adminUser.findUniqueOrThrow({
      where: { email: "reset@test.example" },
    });
    const { sha256 } = await import("../src/lib/crypto");
    await prisma.adminPasswordReset.create({
      data: {
        adminUserId: user.id,
        tokenHash: sha256("known-token-known-token-known"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const ok = await request(app)
      .post("/api/v1/admin/auth/reset-password")
      .send({ token: "known-token-known-token-known", newPassword: "Reset-Pass-12345" });
    expect(ok.status).toBe(200);
    const again = await request(app)
      .post("/api/v1/admin/auth/reset-password")
      .send({ token: "known-token-known-token-known", newPassword: "Reset-Pass-67890" });
    expect(again.status).toBe(400);
    await loginAdmin(app, "reset@test.example", "Reset-Pass-12345");
  });
});

describe("roles & permissions", () => {
  it("denies actions lacking permission and allows those granted", async () => {
    await createAdminWithRole("SUPPORT", "support@test.example");
    const s = await loginAdmin(app, "support@test.example", "Another-Pass-123");
    expect((await s.get("/api/v1/admin/users")).status).toBe(200); // users.read via readOnly
    const create = await s.post("/api/v1/admin/users", {
      email: "n@x.example",
      name: "N",
      password: "Valid-Pass-12345",
      roleId: "x",
    });
    expect(create.status).toBe(403);
    expect((await s.put("/api/v1/admin/settings", { name: "Hack" })).status).toBe(403);
  });

  it("admin cannot escalate to super admin; last super admin is protected", async () => {
    await createAdminWithRole("ADMIN", "adm@test.example");
    const adm = await loginAdmin(app, "adm@test.example", "Another-Pass-123");
    const superRole = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    const r = await adm.post("/api/v1/admin/users", {
      email: "e@x.example",
      name: "E",
      password: "Valid-Pass-12345",
      roleId: superRole.id,
    });
    expect(r.status).toBe(403);
    const root = await loginAdmin(app);
    const rootUser = await prisma.adminUser.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    const res = await root.patch(`/api/v1/admin/users/${rootUser.id}`, { isActive: false });
    expect(res.status).toBe(409);
  });

  it("deactivating a user kills their sessions and writes an audit log", async () => {
    const u = await createAdminWithRole("CONTENT_MANAGER", "cm@test.example");
    const cm = await loginAdmin(app, "cm@test.example", "Another-Pass-123");
    const root = await loginAdmin(app);
    expect((await root.patch(`/api/v1/admin/users/${u.id}`, { isActive: false })).status).toBe(200);
    expect((await cm.get("/api/v1/admin/auth/me")).status).toBe(401);
    const logs = await root.get("/api/v1/admin/audit-logs?action=user.update");
    expect(logs.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.body)).not.toMatch(/passwordHash|Another-Pass/);
  });
});

describe("store settings", () => {
  it("serves public projection and persists admin updates with validation", async () => {
    const root = await loginAdmin(app);
    const bad = await root.put("/api/v1/admin/settings", { currency: "dollars" });
    expect(bad.status).toBe(422);
    const ok = await root.put("/api/v1/admin/settings", {
      name: "Acme",
      currency: "INR",
      locale: "en-IN",
      timezone: "Asia/Kolkata",
      tax: { mode: "INDIA_GST", defaultRate: 18, gstin: "29ABCDE1234F1Z5" },
      features: { blog: false },
    });
    expect(ok.status).toBe(200);
    const pub = await request(app).get("/api/v1/store/settings");
    expect(pub.body.name).toBe("Acme");
    expect(pub.body.currency).toBe("INR");
    expect(pub.body.features.blog).toBe(false);
    expect(pub.body.tax.gstin).toBeUndefined(); // internal tax identifiers aren't in the public projection
  });
});
