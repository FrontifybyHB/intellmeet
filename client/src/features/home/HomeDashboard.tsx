import {
  ArrowRight,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  Clock3,
  FileText,
  LayoutDashboard,
  Plus,
  Radio,
  Settings2,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { ROUTES, meetingPath, meetingResultsPath } from "@/app/paths";
import { useAuth } from "@/features/auth/useAuth";
import { fetchMeetingHistory, type MeetingHistoryRow } from "@/features/meetings/api";
import { describeApiError } from "@/shared/api/errors";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { cn } from "@/shared/lib/utils";

function formatDate(value: string | null): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: string): string {
  return status.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function MeetingLink({ meeting }: { meeting: MeetingHistoryRow }) {
  const href =
    meeting.status === "ended" ? meetingResultsPath(meeting.id) : meetingPath(meeting.id);
  return (
    <Link
      to={href}
      className="group flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate font-medium text-foreground">
            {meeting.title || "Untitled meeting"}
          </h3>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground">
            {statusLabel(meeting.status)}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {meeting.status === "ended"
            ? formatDate(meeting.endedAt)
            : formatDate(meeting.scheduledAt)}{" "}
          · {meeting.isHost ? "Host" : "Participant"}
        </p>
      </div>
      <ArrowRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </Link>
  );
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
  tone = "text-primary",
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Video;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{label}</span>
        <Icon aria-hidden="true" className={cn("size-5", tone)} />
      </div>
      <div className="mt-4 text-3xl font-semibold tracking-tight text-foreground">{value}</div>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

export function HomeDashboard() {
  const { user } = useAuth();
  const [meetings, setMeetings] = useState<MeetingHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchMeetingHistory()
      .then((page) => {
        if (!cancelled) {
          setMeetings(Array.isArray(page.meetings) ? page.meetings : []);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(describeApiError(err, "Could not load your overview."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const liveMeetings = useMemo(
    () => meetings.filter((meeting) => ["live", "active", "in_progress"].includes(meeting.status)),
    [meetings],
  );
  const scheduledMeetings = useMemo(
    () => meetings.filter((meeting) => ["scheduled", "upcoming"].includes(meeting.status)),
    [meetings],
  );
  const recentMeetings = useMemo(
    () => meetings.filter((meeting) => meeting.status === "ended").slice(0, 3),
    [meetings],
  );
  const hostCount = useMemo(() => meetings.filter((meeting) => meeting.isHost).length, [meetings]);
  const displayName = user?.name || user?.email || "there";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`Good to see you, ${displayName}. Keep your meetings and follow-through in one place.`}
        actions={
          <Button asChild>
            <Link to={ROUTES.newMeeting}>
              <Plus aria-hidden="true" />
              New meeting
            </Link>
          </Button>
        }
      />

      <section
        className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,2fr)]"
        aria-label="Workspace actions and meeting metrics"
      >
        <Card className="relative overflow-hidden bg-gradient-to-br from-card to-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-primary">
                Workspace stage
              </span>
              <Radio aria-hidden="true" className="size-5 text-muted-foreground" />
            </div>
            <CardTitle className="pt-2 text-xl">Start or join a focused meeting</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={ROUTES.newMeeting}>
                <Video aria-hidden="true" />
                New meeting
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={ROUTES.meetings}>
                <FileText aria-hidden="true" />
                Browse meetings
              </Link>
            </Button>
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Metric
            label="Meetings loaded"
            value={loading ? "…" : String(meetings.length)}
            note={loading ? "Loading history" : "From your entitled history"}
            icon={LayoutDashboard}
          />
          <Metric
            label="Live now"
            value={loading ? "…" : String(liveMeetings.length)}
            note="Verified meeting status"
            icon={Radio}
            tone="text-emerald-600 dark:text-emerald-400"
          />
          <Metric
            label="Scheduled"
            value={loading ? "…" : String(scheduledMeetings.length)}
            note="Upcoming in loaded history"
            icon={CalendarDays}
            tone="text-sky-600 dark:text-sky-400"
          />
          <Metric
            label="Hosted"
            value={loading ? "…" : String(hostCount)}
            note="Meetings you host"
            icon={CheckCircle2}
            tone="text-amber-600 dark:text-amber-400"
          />
        </div>
      </section>

      {loading ? <LoadingState label="Loading your meeting overview…" /> : null}
      {!loading && error ? <ErrorState title="Overview unavailable" message={error} /> : null}
      {!loading && !error && meetings.length === 0 ? (
        <EmptyState
          icon={CalendarPlus}
          title="No meetings yet"
          description="Create your first meeting to start a workspace history."
          action={
            <Button asChild>
              <Link to={ROUTES.newMeeting}>Create a meeting</Link>
            </Button>
          }
        />
      ) : null}

      {!loading && !error && meetings.length > 0 ? (
        <>
          <section className="space-y-3" aria-labelledby="active-meetings-heading">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="active-meetings-heading" className="text-lg font-semibold">
                  Live &amp; scheduled
                </h2>
                <p className="text-sm text-muted-foreground">
                  Only statuses returned by the meetings API are shown.
                </p>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link to={ROUTES.meetings}>
                  View all
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
            {liveMeetings.length + scheduledMeetings.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                No live or scheduled meetings in the loaded history.
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {[...liveMeetings, ...scheduledMeetings].map((meeting) => (
                  <MeetingLink key={meeting.id} meeting={meeting} />
                ))}
              </div>
            )}
          </section>
          <section className="space-y-3" aria-labelledby="recent-meetings-heading">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="recent-meetings-heading" className="text-lg font-semibold">
                  Recent meetings
                </h2>
                <p className="text-sm text-muted-foreground">
                  Open a meeting to view its room or results.
                </p>
              </div>
              <Settings2 aria-hidden="true" className="size-5 text-muted-foreground" />
            </div>
            {recentMeetings.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                No completed meetings in the loaded history.
              </div>
            ) : (
              <div className="grid gap-3">
                {recentMeetings.map((meeting) => (
                  <MeetingLink key={meeting.id} meeting={meeting} />
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}

      <Card className="border-dashed">
        <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Clock3 aria-hidden="true" className="mt-0.5 size-5 text-muted-foreground" />
            <div>
              <p className="font-medium">Time, transcript and action analytics</p>
              <p className="text-sm text-muted-foreground">
                Not available in the current history contract; no synthetic metrics are shown.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={ROUTES.meetings}>
              Open history
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
