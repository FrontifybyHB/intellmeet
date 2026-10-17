import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { SessionGate } from "@/components/SessionGate";
import { ROUTES } from "@/routes/paths";

/**
 * Guards authenticated areas. Unauthenticated visitors are redirected to the
 * login route, which returns them to the original location after sign-in.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <SessionGate />;
  }

  if (!user) {
    return (
      <Navigate
        to={ROUTES.login}
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <>{children}</>;
}
