import type {
  CreateShipmentInput,
  CreateShipmentResult,
  RateRequest,
  ShippingProvider,
  ShippingRate,
  TrackingResult,
} from "@kash-commerce/provider-sdk";

/** No carrier integration: rates come from the ShippingMethod table, tracking is entered by admins. */
export class ManualShippingProvider implements ShippingProvider {
  readonly key = "MANUAL";

  async getRates(_input: RateRequest): Promise<ShippingRate[]> {
    return [];
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    return {
      providerShipmentId: `manual_${input.orderNumber}`,
      awb: undefined,
      carrier: undefined,
    };
  }

  async cancelShipment(_providerShipmentId: string): Promise<void> {
    /* nothing to cancel upstream */
  }

  async trackShipment(_providerShipmentId: string, _awb?: string): Promise<TrackingResult> {
    return { status: "CREATED", events: [] };
  }
}
