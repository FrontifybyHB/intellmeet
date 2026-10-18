// Shown while the session bootstrap request (GET /auth/me) is in flight.
// Shared by ProtectedRoute and PublicRoute so the markup lives in one place.
export function SessionGate() {
  return (
    <main>
      <p>Checking your session…</p>
    </main>
  );
}
