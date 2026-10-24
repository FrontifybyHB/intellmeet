import { createContext, useContext } from "react";

import type { SafeUser } from "@/features/auth/types";

export interface AuthState {
  user: SafeUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

/**
 * Reads the session state owned by AuthProvider.
 *
 * Kept in its own module so AuthProvider only exports a component: mixing
 * component and hook exports in one file breaks React Fast Refresh.
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider.");
  return ctx;
}
