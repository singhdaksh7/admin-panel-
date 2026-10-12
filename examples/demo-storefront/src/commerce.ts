import { createCommerceClient, type CommerceClient } from "@kash-commerce/storefront-sdk";

/** The ONLY configuration of this app. */
export const API_URL: string = import.meta.env.VITE_COMMERCE_API_URL ?? "http://localhost:4000";

export function createClient(): CommerceClient {
  return createCommerceClient({
    baseUrl: API_URL,
    // `include` (the default) is what sends the customer session cookie to the API origin.
    credentials: "include",
  });
}
