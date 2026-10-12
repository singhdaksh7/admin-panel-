/* eslint-disable @typescript-eslint/no-explicit-any -- provider payloads are untyped JSON */
import type {
  CreateShipmentInput,
  CreateShipmentResult,
  RateRequest,
  ShippingProvider,
  ShippingRate,
  TrackingResult,
} from "@kash-commerce/provider-sdk";
import { fromMinor, toMinor } from "@kash-commerce/shared";
import { providerError, timedFetch, type FetchLike } from "../payment/http";

export interface ShiprocketOptions {
  email: string;
  password: string;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => number;
  /** Pickup location *name* configured in the Shiprocket panel. Default "Primary". */
  pickupLocation?: string;
  /** Pickup postcode, required for serviceability (rates). */
  pickupPostcode?: string;
  /** Backoff before the single retry of an idempotent GET. Default 300ms. */
  retryDelayMs?: number;
}

/** Tokens last 10 days; we refresh after 9 days minus a margin. */
const TOKEN_TTL_MS = 9 * 24 * 3600 * 1000 - 3600 * 1000;

type Json = Record<string, any>;

interface ReqOpts {
  retry?: boolean;
}

export class ShiprocketProvider implements ShippingProvider {
  readonly key = "SHIPROCKET";
  private readonly email: string;
  private readonly password: string;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private pickupLocation: string;
  private pickupPostcode?: string;
  private readonly retryDelayMs: number;
  private token?: { value: string; expiresAt: number };
  private loginInFlight?: Promise<string>;
  /** shipment_id -> order_id, needed for cancellation (Shiprocket cancels by order id). */
  private readonly orderIds = new Map<string, string>();

  constructor(opts: ShiprocketOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? "https://apiv2.shiprocket.in").replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
    this.pickupLocation = opts.pickupLocation ?? "Primary";
    this.pickupPostcode = opts.pickupPostcode;
    this.retryDelayMs = opts.retryDelayMs ?? 300;
  }

  /** Applies non-secret admin settings (IntegrationSetting) at runtime. Unset keys keep their value. */
  configure(opts: { pickupLocation?: string; pickupPostcode?: string }): void {
    if (opts.pickupLocation) this.pickupLocation = opts.pickupLocation;
    if (opts.pickupPostcode) this.pickupPostcode = opts.pickupPostcode;
  }

  private login(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now())
      return Promise.resolve(this.token.value);
    if (this.loginInFlight) return this.loginInFlight;
    const p = (async () => {
      const res = await timedFetch(
        this.fetchFn,
        "Shiprocket",
        `${this.baseUrl}/v1/external/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: this.email, password: this.password }),
        },
      );
      const token = (res.body as Json | null)?.token;
      if (!res.ok || typeof token !== "string")
        throw providerError("Shiprocket", `login failed with status ${res.status}`, res.status);
      this.token = { value: token, expiresAt: this.now() + TOKEN_TTL_MS };
      return token;
    })().finally(() => {
      this.loginInFlight = undefined;
    });
    this.loginInFlight = p;
    return p;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: ReqOpts = {},
  ): Promise<Json> {
    let relogged = false;
    let retried = false;
    let token = await this.login();
    for (;;) {
      const res = await timedFetch(this.fetchFn, "Shiprocket", `${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) return (res.body ?? {}) as Json;
      if (res.status === 401 && !relogged) {
        relogged = true;
        this.token = undefined;
        token = await this.login(true);
        continue;
      }
      if (opts.retry && !retried && (res.status === 429 || res.status >= 500)) {
        retried = true;
        await this.sleep(this.retryDelayMs);
        continue;
      }
      throw providerError("Shiprocket", `upstream responded with status ${res.status}`, res.status);
    }
  }

  async getRates(input: RateRequest): Promise<ShippingRate[]> {
    if (!this.pickupPostcode) throw providerError("Shiprocket", "pickup postcode not configured");
    const grams = input.items.reduce((s, i) => s + (i.weightGrams ?? 500) * i.quantity, 0);
    const kg = Math.max(grams, 100) / 1000;
    const qs = new URLSearchParams({
      pickup_postcode: this.pickupPostcode,
      delivery_postcode: input.destination.postalCode,
      weight: String(kg),
      cod: input.paymentMode === "COD" ? "1" : "0",
    });
    const data = await this.request("GET", `/v1/external/courier/serviceability?${qs}`, undefined, {
      retry: true,
    });
    const list: Json[] = data.data?.available_courier_companies ?? [];
    return list.map((c) => {
      const days = Number(c.estimated_delivery_days);
      const d = Number.isFinite(days) && days > 0 ? days : undefined;
      return {
        id: String(c.courier_company_id),
        name: String(c.courier_name),
        carrier: String(c.courier_name),
        price: fromMinor(Math.round(Number(c.rate) * 100)),
        ...(d !== undefined ? { minDays: d, maxDays: d } : {}),
      };
    });
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const d = input.destination;
    const grams =
      input.weightGrams ?? input.items.reduce((s, i) => s + (i.weightGrams ?? 500) * i.quantity, 0);
    const created = await this.request("POST", "/v1/external/orders/create/adhoc", {
      order_id: input.orderNumber,
      order_date: new Date(this.now()).toISOString().slice(0, 16).replace("T", " "),
      pickup_location: this.pickupLocation,
      billing_customer_name: d.name,
      billing_last_name: "",
      billing_address: d.line1,
      billing_address_2: d.line2 ?? "",
      billing_city: d.city,
      billing_pincode: d.postalCode,
      billing_state: d.state ?? "",
      billing_country: d.country,
      billing_email: "",
      billing_phone: d.phone ?? "",
      shipping_is_billing: true,
      order_items: input.items.map((i) => ({
        name: i.name,
        sku: i.sku,
        units: i.quantity,
        selling_price: i.unitPrice,
      })),
      payment_method: input.paymentMode === "COD" ? "COD" : "Prepaid",
      sub_total: Number(fromMinor(toMinor(input.total))),
      length: 10,
      breadth: 10,
      height: 10,
      weight: Math.max(grams, 100) / 1000,
    });
    const shipmentId = created.shipment_id;
    if (shipmentId === undefined || shipmentId === null || shipmentId === 0)
      throw providerError("Shiprocket", "shipment was not created");
    const providerShipmentId = String(shipmentId);
    if (created.order_id !== undefined)
      this.orderIds.set(providerShipmentId, String(created.order_id));

    // Never retried: a duplicate assign could double-book a courier.
    const assigned = await this.request("POST", "/v1/external/courier/assign/awb", {
      shipment_id: shipmentId,
    });
    const awbData = assigned.response?.data ?? {};
    const awb: string | undefined = awbData.awb_code ? String(awbData.awb_code) : undefined;
    const carrier: string | undefined = awbData.courier_name
      ? String(awbData.courier_name)
      : undefined;

    try {
      await this.request("POST", "/v1/external/courier/generate/pickup", {
        shipment_id: [shipmentId],
      });
    } catch {
      /* best effort: pickup can be scheduled from the Shiprocket panel */
    }

    return {
      providerShipmentId,
      awb,
      carrier,
      trackingUrl: awb ? `https://shiprocket.co/tracking/${encodeURIComponent(awb)}` : undefined,
    };
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    let orderId = this.orderIds.get(providerShipmentId);
    if (!orderId) {
      // after a restart the shipment->order map is gone: resolve it from Shiprocket
      try {
        const info = await this.request(
          "GET",
          `/v1/external/shipments/${encodeURIComponent(providerShipmentId)}`,
          undefined,
          { retry: true },
        );
        const found = info.data?.order_id ?? info.order_id;
        if (found !== undefined && found !== null) orderId = String(found);
      } catch {
        /* fall through to the shipment id */
      }
    }
    orderId ??= providerShipmentId;
    await this.request("POST", "/v1/external/orders/cancel", { ids: [Number(orderId) || orderId] });
  }

  async trackShipment(providerShipmentId: string, awb?: string): Promise<TrackingResult> {
    if (!awb) return { status: "CREATED", events: [] };
    void providerShipmentId;
    const data = await this.request(
      "GET",
      `/v1/external/courier/track/awb/${encodeURIComponent(awb)}`,
      undefined,
      { retry: true },
    );
    const td: Json = data.tracking_data ?? {};
    const activities: Json[] = Array.isArray(td.shipment_track_activities)
      ? td.shipment_track_activities
      : [];
    const events = activities.map((a) => ({
      at: String(a.date ?? ""),
      status: String(a["sr-status-label"] ?? a.activity ?? ""),
      ...(a.location ? { location: String(a.location) } : {}),
    }));
    return { status: mapStatus(td), events };
  }
}

function mapStatus(td: Json): TrackingResult["status"] {
  if (td.track_status === 0) return "CREATED";
  const code = Number(td.shipment_status ?? td.shipment_track?.[0]?.current_status_id);
  if (code === 7) return "DELIVERED";
  if (code === 8 || code === 16) return "CANCELLED";
  if ([9, 10, 12, 13, 14, 21, 22].includes(code)) return "FAILED";
  if (Number.isFinite(code) && code <= 5) return "CREATED";
  return "IN_TRANSIT";
}
