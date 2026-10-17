import { Link } from "react-router-dom";
import { ROUTES } from "@/routes/paths";

/**
 * Meetings index placeholder. Meeting list/search/filter/pagination is the
 * meeting-management phase; creation already exists and is linked here.
 */
export function MeetingsPage() {
  return (
    <main>
      <h1>Meetings</h1>
      <p>Your meeting list and management tools will live here.</p>
      <nav aria-label="Meeting actions">
        <Link to={ROUTES.newMeeting}>Create a meeting</Link>
      </nav>
    </main>
  );
}
