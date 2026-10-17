import { Link, Outlet } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { IS_DEV } from "@/config/env";
import { ROUTES } from "@/routes/paths";

/**
 * Shared application shell for authenticated routes. Structural only — the
 * design-system phase owns the real sidebar/navbar styling.
 *
 * Rendered inside ProtectedRoute, so `user` is non-null in practice; the
 * null guard only covers the render tick before the session resolves.
 */
export function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="app-layout">
      <header className="app-layout__header">
        <Link to={ROUTES.home}>IntellMeet</Link>
        <nav aria-label="Primary">
          <Link to={ROUTES.home}>Home</Link>
          <Link to={ROUTES.meetings}>Meetings</Link>
          <Link to={ROUTES.account}>Account</Link>
          {IS_DEV && (
            <>
              <Link to={ROUTES.devLab}>Meeting Lab</Link>
              <Link to={ROUTES.devPost}>Post-meeting</Link>
              <Link to={ROUTES.devBench}>API Test Bench</Link>
            </>
          )}
        </nav>
        <div className="app-layout__account">
          {user && <span>{user.name || user.email}</span>}
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
