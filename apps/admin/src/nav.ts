/**
 * Sidebar model. An item is shown only if the admin holds `perm` (any listed is NOT enough: ALL).
 * Paths must match routes registered in src/routes.tsx.
 */
export interface NavItem {
  label: string;
  path: string;
  perm?: string;
}
export interface NavSection {
  title?: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  { items: [{ label: "Dashboard", path: "/", perm: "dashboard.read" }] },
  {
    title: "Catalog",
    items: [
      { label: "Products", path: "/products", perm: "products.read" },
      { label: "Categories", path: "/categories", perm: "categories.read" },
      { label: "Collections", path: "/collections", perm: "products.read" },
      { label: "Attributes", path: "/attributes", perm: "products.read" },
      { label: "Inventory", path: "/inventory", perm: "inventory.read" },
    ],
  },
  {
    title: "Orders",
    items: [
      { label: "Orders", path: "/orders", perm: "orders.read" },
      { label: "Returns", path: "/returns", perm: "returns.read" },
    ],
  },
  { items: [{ label: "Customers", path: "/customers", perm: "customers.read" }] },
  {
    title: "Marketing",
    items: [
      { label: "Coupons", path: "/coupons", perm: "coupons.read" },
      { label: "Reviews", path: "/reviews", perm: "reviews.read" },
    ],
  },
  {
    title: "Content",
    items: [
      { label: "Pages", path: "/pages", perm: "content.read" },
      { label: "Navigation", path: "/navigation", perm: "content.read" },
      { label: "Blog", path: "/blog", perm: "content.read" },
      { label: "Media", path: "/media", perm: "media.read" },
    ],
  },
  {
    title: "Storefront",
    items: [
      { label: "Filters", path: "/filters", perm: "filters.write" },
      { label: "SEO", path: "/seo", perm: "seo.write" },
      { label: "Store Settings", path: "/settings", perm: "settings.read" },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Admin Users", path: "/users", perm: "users.read" },
      { label: "Roles", path: "/roles", perm: "users.read" },
      { label: "Notifications", path: "/notifications", perm: "settings.read" },
      { label: "Audit Logs", path: "/audit-logs", perm: "audit.read" },
      { label: "Integrations", path: "/integrations", perm: "integrations.manage" },
    ],
  },
];
