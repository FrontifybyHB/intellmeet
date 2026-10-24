import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { deleteMeeting, fetchMeetingDetail, type MeetingDetail } from "@/features/meetings/api";
import { PostMeetingPanel } from "@/features/postMeeting/PostMeetingPanel";
import { RecordingPanel } from "@/features/recordings/RecordingPanel";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ROUTES } from "@/app/paths";
import { describeApiError } from "@/shared/api/errors";

/** Authenticated post-meeting surface; live calls stay in MeetingRoom. */
export function MeetingResultsPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMeetingDetail(id)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err) => {
        if (!cancelled) setError(describeApiError(err, "Could not load meeting results."));
      });
    return () => { cancelled = true; };
  }, [id]);

  const remove = async () => {
    setDeleteError(null);
    try {
      await deleteMeeting(id);
      navigate(ROUTES.meetings, { replace: true });
    } catch (err) {
      const message = describeApiError(err, "Could not delete the meeting.");
      setDeleteError(message);
      throw err;
    }
  };

  if (error) return <ErrorState title="Meeting results unavailable" message={error} action={<Button asChild><Link to={ROUTES.meetings}>Back to meetings</Link></Button>} />;
  if (!detail) return <LoadingState label="Loading meeting results…" />;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title={detail.meeting.title || "Untitled meeting"}
        description={detail.meeting.status === "ended" ? "Recording, transcript, summary and action items." : `Meeting status: ${detail.meeting.status}`}
        actions={
          detail.meeting.isHost ? (
            <ConfirmationDialog
              trigger={<Button type="button" variant="destructive">Delete meeting</Button>}
              title="Delete this meeting?"
              description="This removes the meeting from normal history, blocks future joins and revokes app-level access. Retained media and records are not hard-deleted."
              confirmLabel="Delete meeting"
              destructive
              onConfirm={remove}
            />
          ) : undefined
        }
      />
      {deleteError ? <ErrorState title="Meeting was not deleted" message={deleteError} /> : null}
      <RecordingPanel meetingId={id} isHost={detail.meeting.isHost} selectedRecordingId={searchParams.get("recording")} />
      <PostMeetingPanel meetingId={id} isHost={detail.meeting.isHost} />
    </div>
  );
}
