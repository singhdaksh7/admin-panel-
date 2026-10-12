/**
 * Where the anonymous cart token lives. Implement this to use cookies, AsyncStorage, Redis, ...
 * Methods may be sync or async.
 */
export interface CartStorage {
  get(): string | null | undefined | Promise<string | null | undefined>;
  set(token: string): void | Promise<void>;
  remove(): void | Promise<void>;
}

export const DEFAULT_CART_STORAGE_KEY = "kash.cartToken";

/** In-memory storage: SSR-safe, per client instance. */
export function createMemoryCartStorage(initial?: string | null): CartStorage {
  let token: string | null = initial ?? null;
  return {
    get: () => token,
    set: (t) => {
      token = t;
    },
    remove: () => {
      token = null;
    },
  };
}

interface StringStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Wrap a Web Storage object; every access is try/catch-guarded (private mode, blocked storage). */
export function createWebCartStorage(
  storage: StringStorage,
  key = DEFAULT_CART_STORAGE_KEY,
): CartStorage {
  return {
    get: () => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (t) => {
      try {
        storage.setItem(key, t);
      } catch {
        /* ignore */
      }
    },
    remove: () => {
      try {
        storage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** localStorage when it is usable, otherwise memory (SSR, Node, private mode). */
export function createDefaultCartStorage(key = DEFAULT_CART_STORAGE_KEY): CartStorage {
  try {
    const ls = (globalThis as { localStorage?: StringStorage }).localStorage;
    if (ls) {
      const probe = `${key}.__probe`;
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return createWebCartStorage(ls, key);
    }
  } catch {
    /* fall through */
  }
  return createMemoryCartStorage();
}
