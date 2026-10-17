import { Link, Outlet } from "react-router-dom";
import { ROUTES } from "@/routes/paths";

/**
 * Structural wrapper for signed-out routes (login, register, invite landing).
 * Intentionally unstyled — the design-system phase restyles it.
 */
export function AuthLayout() {
  return (
    <div className="auth-layout">
      <header className="auth-layout__header">
        <Link to={ROUTES.home}>IntellMeet</Link>
      </header>
      <Outlet />
    </div>
  );
}
