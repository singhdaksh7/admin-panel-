export interface ShipmentAddress {
  name: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}
export interface ShipmentItem {
  name: string;
  sku: string;
  quantity: number;
  unitPrice: string;
  weightGrams?: number;
}
export interface RateRequest {
  destination: ShipmentAddress;
  items: ShipmentItem[];
  subtotal: string;
  currency: string;
  paymentMode: "PREPAID" | "COD";
}
export interface ShippingRate {
  id: string;
  name: string;
  price: string;
  minDays?: number;
  maxDays?: number;
  carrier?: string;
}
export interface CreateShipmentInput {
  orderNumber: string;
  destination: ShipmentAddress;
  items: ShipmentItem[];
  total: string;
  currency: string;
  paymentMode: "PREPAID" | "COD";
  weightGrams?: number;
}
export interface CreateShipmentResult {
  providerShipmentId: string;
  awb?: string;
  carrier?: string;
  trackingUrl?: string;
}
export interface TrackingResult {
  status: "CREATED" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED" | "FAILED";
  events: { at: string; status: string; location?: string }[];
}

export interface ShippingProvider {
  readonly key: string;
  getRates(input: RateRequest): Promise<ShippingRate[]>;
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  cancelShipment(providerShipmentId: string): Promise<void>;
  trackShipment(providerShipmentId: string, awb?: string): Promise<TrackingResult>;
}
