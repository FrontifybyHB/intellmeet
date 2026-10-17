import { Link } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { ROUTES } from "@/routes/paths";

/**
 * Authenticated landing screen. Deliberately minimal: the dashboard module
 * (stats, activity, responsive shell) is a later phase.
 */
export function HomePage() {
  const { user } = useAuth();

  return (
    <main>
      <h1>Welcome to IntellMeet</h1>
      <p>Your meeting and collaboration workspace starts here.</p>
      {user && <p>Signed in as {user.name || user.email}</p>}
      <nav aria-label="Quick actions">
        <Link to={ROUTES.newMeeting}>New meeting</Link> <Link to={ROUTES.meetings}>Meetings</Link>{" "}
        <Link to={ROUTES.account}>Account</Link>
      </nav>
    </main>
  );
}
