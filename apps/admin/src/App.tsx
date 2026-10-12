import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Spinner, ToastProvider } from "./components/ui";
import { Login } from "./features/auth/Login";
import { appRoutes } from "./routes";
import type { RouteObject } from "react-router-dom";
import { ApiError } from "./lib/api";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  });
}

function renderRoutes(rs: RouteObject[]) {
  return rs.map((r, i) =>
    r.index ? (
      <Route key={i} index element={r.element} />
    ) : (
      <Route key={r.path ?? i} path={r.path} element={r.element}>
        {r.children && renderRoutes(r.children)}
      </Route>
    ),
  );
}

function Protected() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Checking session" />;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected />}>{renderRoutes(appRoutes)}</Route>
    </Routes>
  );
}

export function App({ client = makeQueryClient() }: { client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
