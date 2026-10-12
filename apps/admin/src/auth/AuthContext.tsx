import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, refreshSession, setCsrfToken, setSessionLostHandler } from "../lib/api";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
  mustChangePassword?: boolean;
}

interface AuthState {
  user: AdminUser | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** true if the signed-in admin holds ALL given permissions */
  can(...permissions: string[]): boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setSessionLostHandler(clear);
    let cancelled = false;
    api
      .get<{ user: AdminUser & { csrfToken: string } }>("/auth/me")
      .then((r) => {
        if (cancelled) return;
        setCsrfToken(r.user.csrfToken);
        setUser(r.user);
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      setSessionLostHandler(null);
    };
  }, [clear]);

  // keep the rotating session alive while the tab is open
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => void refreshSession(), 10 * 60 * 1000);
    return () => clearInterval(t);
  }, [user]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.post<{ user: AdminUser; csrfToken: string }>("/auth/login", {
      email,
      password,
    });
    setCsrfToken(r.csrfToken);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    clear();
  }, [clear]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login,
      logout,
      can: (...perms) => !!user && perms.every((p) => user.permissions.includes(p)),
    }),
    [user, loading, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

/** Hide children unless the admin has all permissions. */
export function Can({
  perm,
  children,
  fallback = null,
}: {
  perm: string | string[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(...(Array.isArray(perm) ? perm : [perm])) ? children : fallback}</>;
}
