import { Link } from "react-router-dom";
import { ROUTES } from "@/routes/paths";

/** Reusable 404 screen rendered for any unmatched route. */
export function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <p>The page you were looking for does not exist or has moved.</p>
      <nav aria-label="Recovery">
        <Link to={ROUTES.home}>Go to home</Link> <Link to={ROUTES.login}>Sign in</Link>
      </nav>
    </main>
  );
}
