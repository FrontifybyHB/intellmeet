import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ApiError,
  apiFetch,
  clearClientAuthState,
  setCsrfToken,
  type SafeUser,
} from "../services/api";

interface AuthState {
  user: SafeUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      const body = await apiFetch<{ user: SafeUser }>("/auth/me");
      setUser(body.user);
      setError(null);
    } catch (err) {
      // Bootstrap failure means anonymous (expired/revoked/absent).
      // Only surface unexpected (non-401) errors.
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        setError(err instanceof Error ? err.message : "Could not load user.");
        setUser(null);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshUser();
      if (!cancelled) setLoading(false);
    })();
    // Cross-tab coordination: another tab's logout clears this tab's
    // user state (and its in-memory query caches, owned by consumers).
    const onStorage = (e: StorageEvent) => {
      if (e.key === "im:logout") {
        clearClientAuthState();
        setUser(null);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, [refreshUser]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const body = await apiFetch<{ user: SafeUser; csrfToken?: string }>(
        "/auth/login",
        {
          method: "POST",
          body: { email, password },
        },
      );
      if (body.csrfToken) setCsrfToken(body.csrfToken);
      setUser(body.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
      throw err;
    }
  }, []);

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      setError(null);
      try {
        await apiFetch<{ user: SafeUser }>("/auth/register", {
          method: "POST",
          body: { name, email, password },
        });
        // Registration does not auto-login (enumeration-neutral flow):
        // the user signs in explicitly on the login view.
      } catch (err) {
        setError(err instanceof Error ? err.message : "Registration failed.");
        throw err;
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch<{ ok: boolean }>("/auth/logout", {
        method: "POST",
        body: {},
      });
    } catch {
      // Logout is idempotent: a failed request still clears local state
      // (cookies are the server's revocation record).
    } finally {
      clearClientAuthState();
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, login, register, logout, refreshUser }),
    [user, loading, error, login, register, logout, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider.");
  return ctx;
}
