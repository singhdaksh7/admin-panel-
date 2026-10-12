import type { ReactNode } from "react";
import { Navigate, type RouteObject } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Dashboard } from "./features/dashboard/Dashboard";
import { EmptyState } from "./components/ui";

/** Wrap a page so it renders only when the admin holds ALL listed permissions. */
export function Guard({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const list = Array.isArray(perm) ? perm : [perm];
  if (!can(...list)) {
    return (
      <EmptyState
        title="Access denied"
        hint={`You need the ${list.join(", ")} permission to view this page.`}
      />
    );
  }
  return <>{children}</>;
}

export function NotFound() {
  return <EmptyState title="Page not found" hint="The page you are looking for does not exist." />;
}

/**
 * Feature route modules. Each feature owns a folder `src/features/<area>/routes.tsx` that exports
 * `routes: RouteObject[]` (paths relative to "/", wrapped in <Guard perm=...>). Add ONE line below per feature.
 */
import { routes as accountRoutes } from "./features/account/routes";

export const appRoutes: RouteObject[] = [
  {
    index: true,
    element: (
      <Guard perm="dashboard.read">
        <Dashboard />
      </Guard>
    ),
  },
  ...accountRoutes,
  { path: "*", element: <NotFound /> },
];

export function RedirectHome() {
  return <Navigate to="/" replace />;
}
