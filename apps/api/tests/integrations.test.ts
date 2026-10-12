import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, createAdminWithRole, loginAdmin, makeContext, prisma, request } from "./helpers";
import { createApp } from "../src/app";
import { ShiprocketProvider } from "../src/providers/shipping/shiprocket";
import { advanceTo, payViaVerify, placeOrder } from "./paymentsHelpers";

const FAKE_SECRETS = {
  RAZORPAY_KEY_ID: "rzp_test_FAKEKEYID123",
  RAZORPAY_KEY_SECRET: "FAKE-RZP-SECRET-VALUE-9999",
  RAZORPAY_WEBHOOK_SECRET: "FAKE-RZP-WEBHOOK-VALUE-8888",
  SHIPROCKET_EMAIL: "fake-sr@secret-mail.test",
  SHIPROCKET_PASSWORD: "FAKE-SR-PASSWORD-7777",
};

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let ctx: Awaited<ReturnType<typeof bootApp>>["ctx"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;
beforeAll(async () => {
  ({ ctx } = await bootApp());
  // an app whose env carries (fake) provider secrets
  ctx = makeContext(FAKE_SECRETS);
  app = createApp(ctx);
  admin = await loginAdmin(app);
});

const A = "/api/v1/admin/integrations";
const find = (
  body: { kinds: { kind: string; providers: { provider: string }[] }[] },
  kind: string,
  provider: string,
) =>
  body.kinds.find((k) => k.kind === kind)!.providers.find((p) => p.provider === provider) as
    Record<string, unknown> | undefined;

describe("GET /admin/integrations", () => {
  it("lists all kinds with active flag and boolean-only secretsConfigured", async () => {
    const r = await admin.get(A);
    expect(r.status).toBe(200);
    expect(r.body.kinds.map((k: { kind: string }) => k.kind)).toEqual([
      "PAYMENT",
      "SHIPPING",
      "NOTIFICATION",
      "STORAGE",
    ]);
    const mock = find(r.body, "PAYMENT", "MOCK")!;
    expect(mock.isActive).toBe(true);
    const rzp = find(r.body, "PAYMENT", "RAZORPAY")!;
    expect(rzp.isActive).toBe(false);
    expect(rzp.secretsConfigured).toEqual({
      RAZORPAY_KEY_ID: true,
      RAZORPAY_KEY_SECRET: true,
      RAZORPAY_WEBHOOK_SECRET: true,
    });
    const s3 = find(r.body, "STORAGE", "S3")!;
    expect(Object.values(s3.secretsConfigured as object).every((v) => v === false)).toBe(true);
    expect(find(r.body, "STORAGE", "LOCAL")!.isActive).toBe(true);
    expect(find(r.body, "NOTIFICATION", "LOG")!.isActive).toBe(true);
    expect(find(r.body, "SHIPPING", "MANUAL")!.isActive).toBe(true);
  });

  it("never leaks any env secret value in any response", async () => {
    await admin.put(`${A}/PAYMENT/RAZORPAY`, { enabled: true, config: { displayName: "My Shop" } });
    const bodies = [
      JSON.stringify((await admin.get(A)).body),
      JSON.stringify(
        (await admin.put(`${A}/SHIPPING/SHIPROCKET`, { enabled: true, config: {} })).body,
      ),
      JSON.stringify(
        (await admin.put(`${A}/PAYMENT/RAZORPAY`, { enabled: true, config: { key: "x" } })).body,
      ),
      JSON.stringify((await admin.get("/api/v1/admin/payments")).body),
    ];
    for (const b of bodies)
      for (const secret of Object.values(FAKE_SECRETS)) expect(b).not.toContain(secret);
    const audits = JSON.stringify(await prisma.auditLog.findMany());
    for (const secret of Object.values(FAKE_SECRETS)) expect(audits).not.toContain(secret);
  });
});

describe("PUT /admin/integrations/:kind/:provider", () => {
  it("stores valid non-secret config and reflects it in the listing", async () => {
    const r = await admin.put(`${A}/SHIPPING/SHIPROCKET`, {
      enabled: true,
      config: { pickupLocation: "Warehouse 1", pickupPostcode: "411001" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: "SHIPPING",
      provider: "SHIPROCKET",
      enabled: true,
      config: { pickupLocation: "Warehouse 1", pickupPostcode: "411001" },
    });
    const list = await admin.get(A);
    expect(find(list.body, "SHIPPING", "SHIPROCKET")!.config).toEqual({
      pickupLocation: "Warehouse 1",
      pickupPostcode: "411001",
    });
    expect(find(list.body, "SHIPPING", "SHIPROCKET")!.enabled).toBe(true);
    const off = await admin.put(`${A}/storage/s3`, {
      enabled: false,
      config: { publicBaseUrl: "https://cdn.example.com" },
    });
    expect(off.status).toBe(200);
    expect(await prisma.integrationSetting.count()).toBeGreaterThanOrEqual(2);
    expect(
      await prisma.auditLog.count({ where: { action: "integration.update" } }),
    ).toBeGreaterThan(0);
  });

  it("rejects secret-looking keys (any nesting) with a clear message", async () => {
    for (const config of [
      { apiKey: "abc" },
      { client_secret: "abc" },
      { password: "abc" },
      { accessToken: "abc" },
      { nested: { deep: { webhookSecret: "x" } } },
      { displayName: "ok", KEY_ID: "x" },
    ]) {
      const r = await admin.put(`${A}/PAYMENT/RAZORPAY`, { enabled: true, config });
      expect(r.status).toBe(422);
      expect(r.body.error.message).toContain("secrets are set via environment variables");
    }
  });

  it("validates per-provider schemas and unknown integrations", async () => {
    expect(
      (await admin.put(`${A}/SHIPPING/SHIPROCKET`, { enabled: true, config: { whatever: 1 } }))
        .status,
    ).toBe(422);
    expect(
      (
        await admin.put(`${A}/SHIPPING/SHIPROCKET`, {
          enabled: true,
          config: { pickupPostcode: "<script>" },
        })
      ).status,
    ).toBe(422);
    expect(
      (await admin.put(`${A}/STORAGE/S3`, { enabled: true, config: { publicBaseUrl: "notaurl" } }))
        .status,
    ).toBe(422);
    expect((await admin.put(`${A}/PAYMENT/RAZORPAY`, { config: {} })).status).toBe(422);
    expect((await admin.put(`${A}/PAYMENT/STRIPE`, { enabled: true, config: {} })).status).toBe(
      404,
    );
    expect((await admin.put(`${A}/BOGUS/X`, { enabled: true, config: {} })).status).toBe(404);
  });

  it("pushes pickup settings into the live Shiprocket provider at call time", async () => {
    const calls: string[] = [];
    const fetchStub = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const body = url.includes("/auth/login")
        ? { token: "t" }
        : { data: { available_courier_companies: [] } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    ctx.providers.shipping.SHIPROCKET = new ShiprocketProvider({
      email: "a@b.co",
      password: "pw",
      fetch: fetchStub,
    });
    await admin.put(`${A}/SHIPPING/SHIPROCKET`, {
      enabled: true,
      config: { pickupLocation: "Depot", pickupPostcode: "560001" },
    });
    const r = await admin.post(`${A}/shipping/rates-test`, {
      provider: "SHIPROCKET",
      postalCode: "110001",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(calls.some((c) => c.includes("pickup_postcode=560001"))).toBe(true);
  });
});

describe("rates-test + permissions", () => {
  it("rates-test is best effort and never throws raw provider errors", async () => {
    const r = await admin.post(`${A}/shipping/rates-test`, {
      provider: "MANUAL",
      postalCode: "110001",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, rates: [] });
    ctx.providers.activeShipping = "MOCK";
    const m = await admin.post(`${A}/shipping/rates-test`, { postalCode: "110001" });
    expect(m.body.rates.length).toBeGreaterThan(0);
    (ctx.providers.shipping.MOCK as unknown as { failNext: (k: string) => void }).failNext("rates");
    const f = await admin.post(`${A}/shipping/rates-test`, { postalCode: "110001" });
    expect(f.status).toBe(200);
    expect(f.body.ok).toBe(false);
    expect(
      (await admin.post(`${A}/shipping/rates-test`, { provider: "NOPE", postalCode: "1" })).status,
    ).toBe(404);
  });

  it("requires integrations.manage", async () => {
    await createAdminWithRole("ORDER_MANAGER", "om-int@test.example");
    await createAdminWithRole("SUPPORT", "sup-int@test.example");
    await createAdminWithRole("CATALOG_MANAGER", "cm-int@test.example");
    for (const [email, status] of [
      ["om-int@test.example", 403],
      ["sup-int@test.example", 403],
      ["cm-int@test.example", 403],
    ] as const) {
      const s = await loginAdmin(app, email, "Another-Pass-123");
      expect((await s.get(A)).status).toBe(status);
      expect((await s.put(`${A}/PAYMENT/MANUAL`, { enabled: true, config: {} })).status).toBe(
        status,
      );
      expect((await s.post(`${A}/shipping/rates-test`, { postalCode: "1" })).status).toBe(status);
    }
    expect((await request(app).get(A)).status).toBe(401);
  });
});

describe("store settings additions", () => {
  it("accepts orderPrefix / invoicePrefix / returnWindowDays and rejects bad values", async () => {
    const ok = await admin.put("/api/v1/admin/settings", {
      checkout: { orderPrefix: "KC", invoicePrefix: "INV", returnWindowDays: 30 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.checkout).toMatchObject({ orderPrefix: "KC", returnWindowDays: 30 });
    for (const checkout of [
      { orderPrefix: "kc" },
      { orderPrefix: "TOOLONGPREFIX" },
      { orderPrefix: "A-B" },
      { invoicePrefix: "" },
      { returnWindowDays: -1 },
      { returnWindowDays: 1.5 },
    ])
      expect((await admin.put("/api/v1/admin/settings", { checkout })).status).toBe(422);
    const placed = await placeOrder(app);
    expect(placed.order.orderNumber).toMatch(/^KC-\d+$/);
    await payViaVerify(app, placed);
    await advanceTo(ctx, placed.order.id, "CONFIRMED");
    await admin.put("/api/v1/admin/settings", {
      checkout: { orderPrefix: "ORD", returnWindowDays: 14 },
    });
  });
});
