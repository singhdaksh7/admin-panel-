import { describe, expect, it, vi } from "vitest";
import { AppError } from "@kash-commerce/shared";
import { ManualShippingProvider } from "../../src/providers/shipping/manual";
import { MockShippingProvider } from "../../src/providers/shipping/mock";
import { ShiprocketProvider } from "../../src/providers/shipping/shiprocket";

const PASSWORD = "sr-password-secret";
const addr = {
  name: "A B",
  phone: "9999999999",
  line1: "1 Road",
  city: "Pune",
  state: "MH",
  postalCode: "411001",
  country: "India",
};
const items = [{ name: "Tee", sku: "T1", quantity: 2, unitPrice: "100.00", weightGrams: 250 }];
const rateReq = {
  destination: addr,
  items,
  subtotal: "200.00",
  currency: "INR",
  paymentMode: "PREPAID" as const,
};
const shipReq = {
  orderNumber: "N-1",
  destination: addr,
  items,
  total: "200.00",
  currency: "INR",
  paymentMode: "COD" as const,
};

describe("ManualShippingProvider", () => {
  const p = new ManualShippingProvider();
  it("is a passive provider", async () => {
    expect(await p.getRates(rateReq)).toEqual([]);
    const s = await p.createShipment(shipReq);
    expect(s.providerShipmentId).toBe("manual_N-1");
    expect(s.awb).toBeUndefined();
    expect(s.carrier).toBeUndefined();
    await expect(p.cancelShipment("x")).resolves.toBeUndefined();
    expect(await p.trackShipment("x")).toEqual({ status: "CREATED", events: [] });
  });
});

describe("MockShippingProvider", () => {
  it("returns deterministic rates and AWBs", async () => {
    const p = new MockShippingProvider();
    expect((await p.getRates(rateReq)).length).toBeGreaterThan(0);
    const a = await p.createShipment(shipReq);
    const b = await p.createShipment(shipReq);
    expect(a.awb).toBe("MOCKAWB1");
    expect(b.awb).toBe("MOCKAWB2");
  });

  it("progresses tracking and supports cancel", async () => {
    const p = new MockShippingProvider();
    const s = await p.createShipment(shipReq);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await p.trackShipment(s.providerShipmentId)).status);
    expect(statuses).toEqual(["CREATED", "IN_TRANSIT", "DELIVERED", "DELIVERED"]);
    const s2 = await p.createShipment(shipReq);
    await p.cancelShipment(s2.providerShipmentId);
    expect((await p.trackShipment(s2.providerShipmentId)).status).toBe("CANCELLED");
  });

  it("failNext fails exactly once", async () => {
    const p = new MockShippingProvider();
    p.failNext("create");
    await expect(p.createShipment(shipReq)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_ERROR",
    });
    await expect(p.createShipment(shipReq)).resolves.toBeDefined();
  });

  it("refuses production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new MockShippingProvider()).toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

type Handler = (
  url: string,
  init: RequestInit,
) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

function harness(handler: Handler, opts: { now?: () => number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const r = await handler(url, init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const provider = new ShiprocketProvider({
    email: "e@x.com",
    password: PASSWORD,
    fetch: fetchFn,
    pickupLocation: "Warehouse1",
    pickupPostcode: "110001",
    retryDelayMs: 1,
    now: opts.now,
  });
  const logins = () => calls.filter((c) => c.url.endsWith("/auth/login")).length;
  return { provider, calls, logins };
}

const isLogin = (u: string) => u.endsWith("/v1/external/auth/login");

describe("ShiprocketProvider", () => {
  it("caches the token across calls and sends the bearer", async () => {
    const h = harness((u) =>
      isLogin(u)
        ? { status: 200, body: { token: "tok1" } }
        : { status: 200, body: { data: { available_courier_companies: [] } } },
    );
    await h.provider.getRates(rateReq);
    await h.provider.getRates(rateReq);
    expect(h.logins()).toBe(1);
    const get = h.calls.find((c) => c.url.includes("serviceability"))!;
    expect((get.init.headers as Record<string, string>).Authorization).toBe("Bearer tok1");
  });

  it("refreshes the token after expiry", async () => {
    let t = 1_000;
    const h = harness(
      (u) =>
        isLogin(u)
          ? { status: 200, body: { token: "tok" } }
          : { status: 200, body: { data: { available_courier_companies: [] } } },
      { now: () => t },
    );
    await h.provider.getRates(rateReq);
    t += 8 * 24 * 3600 * 1000;
    await h.provider.getRates(rateReq);
    expect(h.logins()).toBe(1);
    t += 2 * 24 * 3600 * 1000;
    await h.provider.getRates(rateReq);
    expect(h.logins()).toBe(2);
  });

  it("single-flights concurrent logins", async () => {
    const h = harness(async (u) => {
      if (isLogin(u)) {
        await new Promise((r) => setTimeout(r, 20));
        return { status: 200, body: { token: "tok" } };
      }
      return { status: 200, body: { data: { available_courier_companies: [] } } };
    });
    await Promise.all([
      h.provider.getRates(rateReq),
      h.provider.getRates(rateReq),
      h.provider.getRates(rateReq),
    ]);
    expect(h.logins()).toBe(1);
  });

  it("re-logs in once on 401, then fails if still 401", async () => {
    let n = 0;
    const h = harness((u) => {
      if (isLogin(u)) return { status: 200, body: { token: `tok${++n}` } };
      const auth = "";
      void auth;
      return n < 2
        ? { status: 401, body: {} }
        : { status: 200, body: { data: { available_courier_companies: [] } } };
    });
    await expect(h.provider.getRates(rateReq)).resolves.toEqual([]);
    expect(h.logins()).toBe(2);

    const bad = harness((u) =>
      isLogin(u) ? { status: 200, body: { token: "t" } } : { status: 401, body: {} },
    );
    await expect(bad.provider.getRates(rateReq)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(bad.logins()).toBe(2);
  });

  it("maps serviceability to rates", async () => {
    const h = harness((u) =>
      isLogin(u)
        ? { status: 200, body: { token: "t" } }
        : {
            status: 200,
            body: {
              data: {
                available_courier_companies: [
                  {
                    courier_company_id: 10,
                    courier_name: "Delhivery",
                    rate: 59.5,
                    estimated_delivery_days: "3",
                  },
                  {
                    courier_company_id: 11,
                    courier_name: "Bluedart",
                    rate: 120,
                    estimated_delivery_days: "",
                  },
                ],
              },
            },
          },
    );
    const rates = await h.provider.getRates({ ...rateReq, paymentMode: "COD" });
    expect(rates).toEqual([
      { id: "10", name: "Delhivery", carrier: "Delhivery", price: "59.50", minDays: 3, maxDays: 3 },
      { id: "11", name: "Bluedart", carrier: "Bluedart", price: "120.00" },
    ]);
    const q = new URL(h.calls.find((c) => c.url.includes("serviceability"))!.url).searchParams;
    expect(q.get("pickup_postcode")).toBe("110001");
    expect(q.get("delivery_postcode")).toBe("411001");
    expect(q.get("cod")).toBe("1");
    expect(q.get("weight")).toBe("0.5");
  });

  it("retries idempotent GETs once on 5xx but never POSTs", async () => {
    let gets = 0;
    const h = harness((u, init) => {
      if (isLogin(u)) return { status: 200, body: { token: "t" } };
      if (init.method === "GET") {
        gets++;
        return gets === 1
          ? { status: 503, body: {} }
          : { status: 200, body: { data: { available_courier_companies: [] } } };
      }
      return { status: 500, body: {} };
    });
    await expect(h.provider.getRates(rateReq)).resolves.toEqual([]);
    expect(gets).toBe(2);

    await expect(h.provider.createShipment(shipReq)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(h.calls.filter((c) => c.url.includes("orders/create/adhoc")).length).toBe(1);

    const always = harness((u) =>
      isLogin(u) ? { status: 200, body: { token: "t" } } : { status: 500, body: {} },
    );
    await expect(always.provider.getRates(rateReq)).rejects.toMatchObject({ status: 502 });
    expect(always.calls.filter((c) => c.url.includes("serviceability")).length).toBe(2);
  });

  it("creates a shipment, assigns an AWB and schedules pickup", async () => {
    const h = harness((u) => {
      if (isLogin(u)) return { status: 200, body: { token: "t" } };
      if (u.includes("orders/create/adhoc"))
        return { status: 200, body: { order_id: 555, shipment_id: 777 } };
      if (u.includes("assign/awb"))
        return {
          status: 200,
          body: { response: { data: { awb_code: "AWB123", courier_name: "Delhivery" } } },
        };
      return { status: 200, body: {} };
    });
    const r = await h.provider.createShipment(shipReq);
    expect(r).toMatchObject({ providerShipmentId: "777", awb: "AWB123", carrier: "Delhivery" });
    expect(r.trackingUrl).toContain("AWB123");
    const create = JSON.parse(h.calls.find((c) => c.url.includes("adhoc"))!.init.body as string);
    expect(create).toMatchObject({
      order_id: "N-1",
      pickup_location: "Warehouse1",
      payment_method: "COD",
      billing_pincode: "411001",
    });
    expect(h.calls.some((c) => c.url.includes("generate/pickup"))).toBe(true);

    await h.provider.cancelShipment("777");
    const cancel = h.calls.find((c) => c.url.endsWith("orders/cancel"))!;
    expect(JSON.parse(cancel.init.body as string)).toEqual({ ids: [555] });
  });

  it("tolerates pickup failure", async () => {
    const h = harness((u) => {
      if (isLogin(u)) return { status: 200, body: { token: "t" } };
      if (u.includes("adhoc")) return { status: 200, body: { order_id: 1, shipment_id: 2 } };
      if (u.includes("assign/awb"))
        return { status: 200, body: { response: { data: { awb_code: "A" } } } };
      return { status: 500, body: {} };
    });
    await expect(h.provider.createShipment(shipReq)).resolves.toMatchObject({ awb: "A" });
  });

  it("maps tracking statuses and events", async () => {
    const track = (code: number) =>
      harness((u) =>
        isLogin(u)
          ? { status: 200, body: { token: "t" } }
          : {
              status: 200,
              body: {
                tracking_data: {
                  track_status: 1,
                  shipment_status: code,
                  shipment_track_activities: [
                    {
                      date: "2025-01-01 10:00:00",
                      activity: "Picked",
                      location: "Pune",
                      "sr-status-label": "PICKED UP",
                    },
                  ],
                },
              },
            },
      ).provider.trackShipment("1", "AWB1");
    expect((await track(7)).status).toBe("DELIVERED");
    expect((await track(6)).status).toBe("IN_TRANSIT");
    expect((await track(8)).status).toBe("CANCELLED");
    expect((await track(9)).status).toBe("FAILED");
    expect((await track(3)).status).toBe("CREATED");
    expect((await track(7)).events).toEqual([
      { at: "2025-01-01 10:00:00", status: "PICKED UP", location: "Pune" },
    ]);
  });

  it("never leaks the password in errors", async () => {
    const loginFail = harness(() => ({ status: 403, body: { message: `bad creds ${PASSWORD}` } }));
    const e1 = await loginFail.provider.getRates(rateReq).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AppError);
    expect(e1).toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    expect(JSON.stringify({ m: (e1 as Error).message, d: (e1 as AppError).details })).not.toContain(
      PASSWORD,
    );

    const net = new ShiprocketProvider({
      email: "e",
      password: PASSWORD,
      fetch: async () => {
        throw new Error(`down ${PASSWORD}`);
      },
    });
    const e2 = await net.cancelShipment("1").catch((e: unknown) => e);
    expect(e2).toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    expect((e2 as Error).message).not.toContain(PASSWORD);
  });
});
