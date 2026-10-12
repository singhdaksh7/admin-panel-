import type {
  CreateShipmentInput,
  CreateShipmentResult,
  RateRequest,
  ShippingProvider,
  ShippingRate,
  TrackingResult,
} from "@kash-commerce/provider-sdk";
import { AppError } from "@kash-commerce/shared";

export type MockShippingFailure = "rates" | "create" | "cancel" | "track";

const PROGRESSION: TrackingResult["status"][] = ["CREATED", "IN_TRANSIT", "DELIVERED"];

export class MockShippingProvider implements ShippingProvider {
  readonly key = "MOCK";
  private counter = 0;
  private readonly trackCalls = new Map<string, number>();
  private readonly cancelled = new Set<string>();
  private pendingFailure: MockShippingFailure | undefined;

  constructor(private readonly opts: { now?: () => Date; allowInProduction?: boolean } = {}) {
    if (process.env.NODE_ENV === "production" && !opts.allowInProduction)
      throw new Error("MockShippingProvider cannot be used when NODE_ENV=production");
  }

  /** Makes the next call of the given kind throw a PROVIDER_ERROR (then resets). */
  failNext(kind: MockShippingFailure): void {
    this.pendingFailure = kind;
  }

  private maybeFail(kind: MockShippingFailure): void {
    if (this.pendingFailure === kind) {
      this.pendingFailure = undefined;
      throw new AppError(502, "PROVIDER_ERROR", "MockShipping request failed: simulated failure");
    }
  }

  async getRates(_input: RateRequest): Promise<ShippingRate[]> {
    this.maybeFail("rates");
    return [
      {
        id: "mock_standard",
        name: "Mock Standard",
        price: "49.00",
        minDays: 4,
        maxDays: 6,
        carrier: "MockCarrier",
      },
      {
        id: "mock_express",
        name: "Mock Express",
        price: "99.00",
        minDays: 1,
        maxDays: 2,
        carrier: "MockCarrier",
      },
    ];
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    this.maybeFail("create");
    this.counter += 1;
    const awb = `MOCKAWB${this.counter}`;
    return {
      providerShipmentId: `mock_ship_${input.orderNumber}_${this.counter}`,
      awb,
      carrier: "MockCarrier",
      trackingUrl: `https://track.example.test/${awb}`,
    };
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    this.maybeFail("cancel");
    this.cancelled.add(providerShipmentId);
  }

  async trackShipment(providerShipmentId: string, _awb?: string): Promise<TrackingResult> {
    this.maybeFail("track");
    const at = (this.opts.now?.() ?? new Date()).toISOString();
    if (this.cancelled.has(providerShipmentId))
      return { status: "CANCELLED", events: [{ at, status: "CANCELLED" }] };
    const n = this.trackCalls.get(providerShipmentId) ?? 0;
    this.trackCalls.set(providerShipmentId, n + 1);
    const idx = Math.min(n, PROGRESSION.length - 1);
    const status = PROGRESSION[idx] as TrackingResult["status"];
    return {
      status,
      events: PROGRESSION.slice(0, idx + 1).map((s) => ({ at, status: s, location: "Mock Hub" })),
    };
  }
}
