import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <main>
        <p>Checking your session…</p>
      </main>
    );
  }
  if (!user) {
    return (
      <main>
        <h1>Welcome to IntellMeet</h1>
        <p>Please sign in to continue to your workspace.</p>
      </main>
    );
  }
  return <>{children}</>;
}
