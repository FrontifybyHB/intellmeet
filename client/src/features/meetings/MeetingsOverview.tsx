// Meetings index content. Search/filter controls are intentionally absent:
// the current history contract exposes only cursor pagination.

import { CalendarClock, CircleCheck, Copy, ExternalLink, Plus, Radio, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { ROUTES, meetingPath, meetingResultsPath } from "@/app/paths";
import { describeApiError } from "@/shared/api/errors";
import { fetchMeetingHistory, type MeetingHistoryRow } from "@/features/meetings/api";

function dateLabel(value: string | null): string {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusMeta(status: string) {
  switch (status) {
    case "live":
    case "active":
    case "in_progress":
      return { label: "Live", icon: Radio, className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" };
    case "scheduled":
    case "upcoming":
      return { label: "Scheduled", icon: CalendarClock, className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300" };
    case "ended":
      return { label: "Completed", icon: CircleCheck, className: "border-border bg-muted text-muted-foreground" };
    case "cancelled":
      return { label: "Cancelled", icon: CircleCheck, className: "border-destructive/25 bg-destructive/5 text-destructive" };
    default:
      return { label: status.replace(/[-_]/g, " "), icon: Video, className: "border-border bg-muted text-muted-foreground" };
  }
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

  const copyMeetingLink = async (meetingId: string) => {
    const url = `${window.location.origin}${meetingPath(meetingId)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // The authenticated detail route is still available as the visible action.
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
      {!loading && error ? (
        <ErrorState title="Meeting history unavailable" message={error} />
      ) : null}
      {!loading && !error && meetings.length === 0 ? (
        <EmptyState
          icon={Video}
          title="No meetings yet"
          description="Create a meeting to get a share link you can send to participants."
          action={
            <Button asChild variant="outline">
              <Link to={ROUTES.newMeeting}>Create a meeting</Link>
            </Button>
          }
        />
      ) : null}
      {!loading && !error && meetings.length > 0 ? (
        <div className="space-y-3" aria-label="Meeting history">
          {meetings.map((meeting) => {
            const meta = statusMeta(meeting.status);
            const Icon = meta.icon;
            const ended = meeting.status === "ended";
            const inactive = meeting.status === "cancelled";
            const destination = ended ? meetingResultsPath(meeting.id) : meetingPath(meeting.id);
            const time = ended ? meeting.endedAt : meeting.scheduledAt;
            return (
              <article key={meeting.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/30 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="max-w-full break-words text-base font-semibold">{meeting.title || "Untitled meeting"}</h2>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.className}`}><Icon aria-hidden="true" className="size-3.5" />{meta.label}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{ended ? "Ended" : meeting.status === "scheduled" ? "Starts" : "Meeting time"}: {dateLabel(time)}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{meeting.isHost ? "You are the host" : "You are a participant"}</span>
                      <span>{ended ? "Results may include recording and AI processing status." : inactive ? "This meeting is unavailable." : "Open details for admission and room status."}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {!ended && !inactive ? <Button type="button" variant="outline" size="sm" aria-label={`Copy internal meeting link for ${meeting.title || "meeting"}`} onClick={() => void copyMeetingLink(meeting.id)}><Copy aria-hidden="true" className="size-4" /><span className="hidden sm:inline">Copy link</span></Button> : null}
                    <Button asChild size="sm" variant={ended ? "outline" : "default"}><Link aria-label={`${meeting.title || "Untitled meeting"}: ${ended ? "view results" : inactive ? "view details" : "open meeting"}`} to={destination}>{ended ? "View results" : inactive ? "View details" : "Open meeting"}<ExternalLink aria-hidden="true" className="size-4" /></Link></Button>
                  </div>
                </div>
              </article>
            );
          })}
          {hasMore ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more meetings"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
