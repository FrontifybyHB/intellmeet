import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { SessionGate } from "@/components/SessionGate";
import { resolveRedirectTarget } from "@/routes/paths";

/**
 * Guards routes that only make sense while signed out (login, register).
 * Authenticated visitors are sent back to the page they came from, or home.
 */
export function PublicRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <SessionGate />;
  }

  if (user) {
    return <Navigate to={resolveRedirectTarget(location.state)} replace />;
  }

  return <>{children}</>;
}
