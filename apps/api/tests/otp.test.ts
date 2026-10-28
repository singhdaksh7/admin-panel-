import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, prisma, request } from "./helpers";
import { PW, addToCart, checkout, seedProduct } from "./commerceHelpers";
import { sha256 } from "../src/lib/crypto";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
beforeAll(async () => {
  ({ app } = await bootApp());
});

describe("customer passwordless / OTP authentication", () => {
  it("requests OTP, hashes code at rest, does not reveal account existence, enforces cooldown", async () => {
    const email = "otp-user@example.com";

    // 1. Request OTP
    const res = await request(app)
      .post("/api/v1/account/otp/request")
      .send({ email });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify OTP record in DB
    const otp = await prisma.customerOtp.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });
    expect(otp).toBeDefined();
    expect(otp?.codeHash).toBeDefined();
    expect(otp?.attempts).toBe(0);
    expect(otp?.usedAt).toBeNull();

    // Verify notification was recorded
    const log = await prisma.notificationLog.findFirst({
      where: { event: "customer.login_code", recipient: email },
      orderBy: { createdAt: "desc" },
    });
    expect(log).toBeDefined();

    // 2. Cooldown check: request again immediately -> 429
    const cooldownRes = await request(app)
      .post("/api/v1/account/otp/request")
      .send({ email });
    expect(cooldownRes.status).toBe(429);
  });

  it("handles invalid codes, increments attempts, and enforces max attempts", async () => {
    const email = "otp-fail@example.com";
    await request(app).post("/api/v1/account/otp/request").send({ email });

    // Send invalid code
    const badRes = await request(app)
      .post("/api/v1/account/otp/verify")
      .send({ email, code: "000000" });
    expect(badRes.status).toBe(401);

    const otp = await prisma.customerOtp.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });
    expect(otp?.attempts).toBe(1);

    // Artificially max out attempts
    await prisma.customerOtp.update({
      where: { id: otp!.id },
      data: { attempts: 5 },
    });

    const maxRes = await request(app)
      .post("/api/v1/account/otp/verify")
      .send({ email, code: "123456" });
    expect(maxRes.status).toBe(429);
  });

  it("verifies valid OTP, creates account, claims guest orders, sets password, and allows login", async () => {
    const email = "claimed-guest@example.com";

    // 1. Place a guest order with this email first
    const { variant } = await seedProduct();
    const token = await addToCart(app, variant.id, 1);
    const orderRes = await checkout(app, token, { email, paymentProvider: "MANUAL" });
    const orderNumber = orderRes.body.order.orderNumber;
    const initialDbOrder = await prisma.order.findUnique({ where: { orderNumber } });
    expect(initialDbOrder?.customerId).toBeNull();

    // 2. Request OTP and manually set code for test predictability
    await request(app).post("/api/v1/account/otp/request").send({ email });
    const knownCode = "654321";
    const otp = await prisma.customerOtp.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });
    await prisma.customerOtp.update({
      where: { id: otp!.id },
      data: { codeHash: sha256(knownCode) },
    });

    // 3. Verify OTP
    const verifyRes = await request(app)
      .post("/api/v1/account/otp/verify")
      .send({ email, code: knownCode });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.customer.email).toBe(email);
    expect(verifyRes.body.customer.emailVerified).toBe(true);
    expect(verifyRes.body.requiresPasswordSetup).toBe(true);

    const rawCookies = verifyRes.headers["set-cookie"] as unknown as string[] | string | undefined;
    const cookie = Array.isArray(rawCookies) ? rawCookies[0]! : String(rawCookies ?? "");
    expect(cookie).toMatch(/kc_customer=/);
    const csrfToken = verifyRes.body.csrfToken;
    const customerId = verifyRes.body.customer.id;

    // 4. Verify guest order was claimed by this customer!
    const refreshedOrder = await prisma.order.findUnique({ where: { orderNumber } });
    expect(refreshedOrder?.customerId).toBe(customerId);

    // 5. Set password using authenticated session
    const setPwRes = await request(app)
      .post("/api/v1/account/set-password")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ password: PW });
    expect(setPwRes.status).toBe(200);

    // 6. Test password-based login with newly set password
    const loginRes = await request(app)
      .post("/api/v1/account/login")
      .send({ email, password: PW });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.customer.id).toBe(customerId);
  });
});
