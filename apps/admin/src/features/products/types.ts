import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { CategoryNode } from "./kit";

export type ProductStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export interface ProductListItem {
  id: string;
  title: string;
  slug: string;
  status: ProductStatus;
  visibility: string;
  brand: string | null;
  isFeatured: boolean;
  category: { id: string; name: string; slug: string } | null;
  image: string | null;
  variantCount: number;
  priceMin: string | null;
  priceMax: string | null;
  totalAvailable: number;
  updatedAt: string;
}

export interface VariantAttr {
  attributeId: string;
  attribute: string;
  valueId: string;
  value: string;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  title: string | null;
  price: string;
  compareAtPrice: string | null;
  cost: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  imageMediaId: string | null;
  isDefault: boolean;
  isActive: boolean;
  position: number;
  attributes: VariantAttr[];
  inventory: {
    onHand: number;
    reserved: number;
    available: number;
    lowStockThreshold: number;
    trackInventory: boolean;
    allowBackorder: boolean;
  } | null;
}

export interface ProductDetail {
  id: string;
  title: string;
  slug: string;
  shortDescription: string | null;
  description: string | null;
  status: ProductStatus;
  visibility: string;
  categoryId: string | null;
  taxClassId: string | null;
  brand: string | null;
  isFeatured: boolean;
  isNew: boolean;
  publishAt: string | null;
  unpublishAt: string | null;
  seo: {
    title?: string;
    description?: string;
    ogImageMediaId?: string | null;
    noIndex?: boolean;
  } | null;
  images: { id: string; mediaId: string; url: string; altText: string | null }[];
  attributeValues: VariantAttr[];
  tags: { id: string; name: string; slug: string }[];
  collections: { id: string; name: string; slug: string }[];
  variants: Variant[];
}

export interface AttributeValue {
  id: string;
  attributeId: string;
  value: string;
  slug: string;
  sortOrder: number;
}
export interface Attribute {
  id: string;
  name: string;
  slug: string;
  type: "TEXT" | "COLOR" | "NUMBER";
  usedForVariants: boolean;
  isFilterable: boolean;
  sortOrder: number;
  values: AttributeValue[];
}

export function useCategoryTree() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<{ items: CategoryNode[] }>("/categories"),
    staleTime: 60_000,
  });
}
export function useAttributes() {
  return useQuery({
    queryKey: ["attributes"],
    queryFn: () => api.get<{ items: Attribute[] }>("/attributes"),
    staleTime: 60_000,
  });
}
export function useCollectionsList() {
  return useQuery({
    queryKey: ["collections"],
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          name: string;
          slug: string;
          type: "MANUAL" | "RULE";
          isActive: boolean;
          rules: unknown;
          description: string | null;
          imageMediaId: string | null;
          sortOrder: number;
          manualProductCount: number;
        }[];
      }>("/collections"),
    staleTime: 60_000,
  });
}
export function useTaxClasses() {
  return useQuery({
    queryKey: ["tax-classes"],
    queryFn: () => api.get<{ items: { id: string; name: string; rate: string }[] }>("/tax-classes"),
    staleTime: 60_000,
  });
}
