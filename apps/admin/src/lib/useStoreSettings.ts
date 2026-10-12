import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface StoreSettingsDto {
  name: string;
  currency: string;
  locale: string;
  timezone: string;
  tax: { mode?: string; defaultRate?: number; gstin?: string; homeState?: string };
  checkout: Record<string, unknown>;
  features: Record<string, boolean>;
  [k: string]: unknown;
}

/** Store settings (currency/locale/feature flags) for formatting and feature gating. */
export function useStoreSettings() {
  return useQuery({
    queryKey: ["store-settings"],
    queryFn: () => api.get<StoreSettingsDto>("/settings"),
    staleTime: 5 * 60_000,
  });
}
