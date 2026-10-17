import { Link, useParams } from "react-router-dom";
import { ROUTES } from "@/routes/paths";

/**
 * Meeting detail placeholder. It exposes the meeting id so flows that land
 * here (invite join, creation) can be verified; the detail view itself
 * (status pointers, participants, recordings, AI output) is a later phase.
 */
export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <main>
      <h1>Meeting</h1>
      <p>
        Meeting ID: <span data-testid="meeting-id">{id}</span>
      </p>
      <p>Participants, recordings and post-meeting output will appear here.</p>
      <nav aria-label="Meeting navigation">
        <Link to={ROUTES.meetings}>Back to meetings</Link>
      </nav>
    </main>
  );
}
