import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  Cart,
  CategoryNode,
  CommerceClient,
  Customer,
  NavigationMenu,
  StoreSettings,
} from "@kash-commerce/storefront-sdk";
import { errorMessage } from "../lib/util";

// ───────────── SDK client ─────────────
const ClientCtx = createContext<CommerceClient | null>(null);

export function useCommerce(): CommerceClient {
  const c = useContext(ClientCtx);
  if (!c) throw new Error("useCommerce must be used inside <AppProviders>");
  return c;
}

// ───────────── store (settings + header nav) ─────────────
interface StoreState {
  settings: StoreSettings | null;
  nav: NavigationMenu | null;
  footer: NavigationMenu | null;
  categories: CategoryNode[];
  loading: boolean;
}
const StoreCtx = createContext<StoreState>({
  settings: null,
  nav: null,
  footer: null,
  categories: [],
  loading: true,
});
export const useStore = () => useContext(StoreCtx);

function StoreProvider({ children }: { children: ReactNode }) {
  const commerce = useCommerce();
  const [state, setState] = useState<StoreState>({
    settings: null,
    nav: null,
    footer: null,
    categories: [],
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    void Promise.all([
      soft(commerce.store.getSettings(), null),
      soft(commerce.navigation.get("header"), null),
      soft(commerce.navigation.get("footer"), null),
      soft(commerce.categories.list(), [] as CategoryNode[]),
    ]).then(([settings, nav, footer, categories]) => {
      if (alive) setState({ settings, nav, footer, categories, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [commerce]);
  return <StoreCtx.Provider value={state}>{children}</StoreCtx.Provider>;
}

// ───────────── auth ─────────────
interface AuthState {
  customer: Customer | null;
  ready: boolean;
  login(email: string, password: string): Promise<void>;
  register(input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }): Promise<void>;
  logout(): Promise<void>;
}
const AuthCtx = createContext<AuthState | null>(null);
export function useAuth(): AuthState {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth must be used inside <AppProviders>");
  return c;
}

// ───────────── cart ─────────────
interface CartState {
  cart: Cart | null;
  busy: boolean;
  error: string | null;
  refresh(): Promise<void>;
  add(variantId: string, quantity?: number): Promise<boolean>;
  setQuantity(variantId: string, quantity: number): Promise<void>;
  remove(variantId: string): Promise<void>;
  applyCoupon(code: string): Promise<boolean>;
  removeCoupon(): Promise<void>;
}
const CartCtx = createContext<CartState | null>(null);
export function useCart(): CartState {
  const c = useContext(CartCtx);
  if (!c) throw new Error("useCart must be used inside <AppProviders>");
  return c;
}

function AuthAndCartProvider({ children }: { children: ReactNode }) {
  const commerce = useCommerce();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [ready, setReady] = useState(false);
  const [cart, setCart] = useState<Cart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCart(await commerce.cart.get());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [commerce]);

  // Restore a session (cookie) on first load. `me()` also loads the CSRF token into the SDK.
  useEffect(() => {
    let alive = true;
    void commerce.auth
      .me()
      .then((s) => alive && setCustomer(s.customer))
      .catch(() => undefined)
      .finally(() => {
        if (alive) setReady(true);
        void refresh();
      });
    return () => {
      alive = false;
    };
  }, [commerce, refresh]);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const auth = useMemo<AuthState>(
    () => ({
      customer,
      ready,
      async login(email, password) {
        // mergeCart: move the anonymous cart into the customer's cart after sign-in
        const s = await commerce.auth.login({ email, password }, { mergeCart: true });
        setCustomer(s.customer);
        await refresh();
      },
      async register(input) {
        const s = await commerce.auth.register(input, { mergeCart: true });
        setCustomer(s.customer);
        await refresh();
      },
      async logout() {
        await commerce.auth.logout();
        setCustomer(null);
        await refresh();
      },
    }),
    [commerce, customer, ready, refresh],
  );

  const cartApi = useMemo<CartState>(
    () => ({
      cart,
      busy,
      error,
      refresh,
      async add(variantId, quantity = 1) {
        const c = await run(() => commerce.cart.add({ variantId, quantity }));
        if (c) setCart(c);
        return !!c;
      },
      async setQuantity(variantId, quantity) {
        const c = await run(() => commerce.cart.update(variantId, quantity));
        if (c) setCart(c);
      },
      async remove(variantId) {
        const c = await run(() => commerce.cart.remove(variantId));
        if (c) setCart(c);
      },
      async applyCoupon(code) {
        const c = await run(() => commerce.cart.applyCoupon(code));
        if (c) setCart(c);
        return !!c;
      },
      async removeCoupon() {
        const c = await run(() => commerce.cart.removeCoupon());
        if (c) setCart(c);
      },
    }),
    [cart, busy, error, refresh, run, commerce],
  );

  return (
    <AuthCtx.Provider value={auth}>
      <CartCtx.Provider value={cartApi}>{children}</CartCtx.Provider>
    </AuthCtx.Provider>
  );
}

export function AppProviders({
  client,
  children,
}: {
  client: CommerceClient;
  children: ReactNode;
}) {
  return (
    <ClientCtx.Provider value={client}>
      <StoreProvider>
        <AuthAndCartProvider>{children}</AuthAndCartProvider>
      </StoreProvider>
    </ClientCtx.Provider>
  );
}
