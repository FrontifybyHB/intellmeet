// Meetings index content. Search/filter controls are intentionally absent:
// the current history contract exposes only cursor pagination.

import { Plus, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { ROUTES, meetingResultsPath } from "@/app/paths";
import { describeApiError } from "@/shared/api/errors";
import { fetchMeetingHistory, type MeetingHistoryRow } from "@/features/meetings/api";

function dateLabel(value: string | null): string {
  if (!value) return "No end date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No end date" : date.toLocaleString();
}

export function MeetingsOverview() {
  const [meetings, setMeetings] = useState<MeetingHistoryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMeetingHistory()
      .then((page) => {
        if (cancelled) return;
        setMeetings(page.meetings);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(describeApiError(err, "Could not load your meetings."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchMeetingHistory(cursor);
      setMeetings((current) => {
        const known = new Set(current.map((meeting) => meeting.id));
        return [...current, ...page.meetings.filter((meeting) => !known.has(meeting.id))];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(describeApiError(err, "Could not load more meetings."));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meetings"
        description="Your entitled meetings, recordings and post-meeting history."
        actions={
          <Button asChild>
            <Link to={ROUTES.newMeeting}>
              <Plus aria-hidden="true" />
              New meeting
            </Link>
          </Button>
        }
      />

      {loading ? <LoadingState label="Loading meetings…" /> : null}
      {!loading && error ? <ErrorState title="Meeting history unavailable" message={error} /> : null}
      {!loading && !error && meetings.length === 0 ? (
        <EmptyState
          icon={Video}
          title="No meetings yet"
          description="Create a meeting to get a share link you can send to participants."
          action={<Button asChild variant="outline"><Link to={ROUTES.newMeeting}>Create a meeting</Link></Button>}
        />
      ) : null}
      {!loading && !error && meetings.length > 0 ? (
        <div className="space-y-3" aria-label="Meeting history">
          {meetings.map((meeting) => (
            <Link
              key={meeting.id}
              to={meeting.status === "ended" ? meetingResultsPath(meeting.id) : `${ROUTES.meetings}/${meeting.id}`}
              className="block rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{meeting.title || "Untitled meeting"}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{dateLabel(meeting.endedAt)}</p>
                </div>
                <span className="rounded-full border px-2.5 py-1 text-xs font-medium capitalize">{meeting.status}</span>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{meeting.isHost ? "Host" : "Participant"} · {meeting.status === "ended" ? "View results" : "Open meeting"}</p>
            </Link>
          ))}
          {hasMore ? <Button type="button" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more meetings"}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
