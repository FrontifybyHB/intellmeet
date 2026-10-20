import { LoadingState } from "@/components/common/LoadingState";

// Shown while the session bootstrap request (GET /auth/me) is in flight.
// Shared by ProtectedRoute and PublicRoute so the markup lives in one place.
export function SessionGate() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4">
      <LoadingState label="Checking your session…" />
    </main>
  );
}
