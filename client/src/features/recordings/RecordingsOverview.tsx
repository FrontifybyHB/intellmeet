import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, FileAudio, RefreshCw, Video } from "lucide-react";
import { Link } from "react-router-dom";

import { fetchMeetingHistory, type MeetingHistoryRow } from "@/features/meetings/api";
import { listMeetingRecordings, type Recording } from "@/features/recordings/api";
import { describeApiError } from "@/shared/api/errors";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { ROUTES, meetingResultsPath } from "@/app/paths";
import { recordingPhase, recordingPhaseLabel } from "@/features/recordings/state";

type RecordingRow = { meeting: MeetingHistoryRow; recording: Recording };

function formatTimestamp(value: string | null): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function formatDuration(durationMs: number | null): string | null {
  if (!durationMs || durationMs < 0) return null;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function recordingTone(state: Recording["state"]): string {
  switch (recordingPhase(state)) {
    case "recording":
      return "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300";
    case "ready":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
    case "aborted":
      return "border-destructive/25 bg-destructive/5 text-destructive";
    default:
      return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
}

export function RecordingsOverview() {
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partialErrors, setPartialErrors] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPartialErrors([]);

    void fetchMeetingHistory()
      .then(async (history) => {
        if (cancelled) return;
        setHistoryHasMore(history?.hasMore === true);
        const endedMeetings = (Array.isArray(history?.meetings) ? history.meetings : []).filter(
          (meeting) => meeting.status === "ended",
        );
        const results = await Promise.all(
          endedMeetings.map(async (meeting) => {
            try {
              const response = await listMeetingRecordings(meeting.id, 20);
              return {
                meeting,
                recordings: Array.isArray(response?.recordings) ? response.recordings : [],
              };
            } catch (err) {
              return {
                meeting,
                recordings: [],
                error: describeApiError(err, "Could not load recordings."),
              };
            }
          }),
        );
        if (cancelled) return;
        setRows(
          results.flatMap(({ meeting, recordings }) =>
            recordings.map((recording) => ({ meeting, recording })),
          ),
        );
        setPartialErrors(
          results.flatMap((result) =>
            result.error ? [`${result.meeting.title || "Untitled meeting"}: ${result.error}`] : [],
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) setError(describeApiError(err, "Could not load your recording history."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const readyCount = useMemo(
    () => rows.filter(({ recording }) => recording.state === "ready").length,
    [rows],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recordings & past meetings"
        description="Review recordings belonging to your entitled meetings."
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => setRefreshKey((key) => key + 1)}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      {loading ? <LoadingState label="Loading recordings…" /> : null}
      {!loading && error ? (
        <ErrorState
          title="Recordings unavailable"
          message={error}
          action={
            <Button variant="outline" onClick={() => setRefreshKey((key) => key + 1)}>
              Try again
            </Button>
          }
        />
      ) : null}
      {!loading && !error && partialErrors.length > 0 ? (
        <ErrorState title="Some recordings are unavailable" message={partialErrors.join(" ")} />
      ) : null}
      {!loading && !error && rows.length === 0 ? (
        <EmptyState
          icon={FileAudio}
          title="No recordings yet"
          description="Recordings appear here after a capture has been started and finished."
          action={
            <Button asChild variant="outline">
              <Link to={ROUTES.meetings}>
                <Video aria-hidden="true" /> Browse meetings
              </Link>
            </Button>
          }
        />
      ) : null}

      {!loading && !error && rows.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-muted-foreground">Recordings loaded</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{rows.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-muted-foreground">Ready to play</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{readyCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-muted-foreground">Source meetings</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">
                  {new Set(rows.map(({ meeting }) => meeting.id)).size}
                </p>
              </CardContent>
            </Card>
          </div>
          <section className="space-y-3" aria-label="Recording history">
            {rows.map(({ meeting, recording }) => (
              <Card key={recording.id} className="overflow-hidden">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                  <div className="min-w-0 space-y-1">
                    <Link
                      to={meetingResultsPath(meeting.id)}
                      className="font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {meeting.title || "Untitled meeting"}
                    </Link>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${recordingTone(recording.state)}`}>
                        {recordingPhaseLabel(recording.state)}
                      </span>
                      <span>{formatTimestamp(recording.createdAt)}</span>
                      {formatDuration(recording.output?.durationMs ?? null) ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock3 aria-hidden="true" className="size-3.5" />
                          {formatDuration(recording.output?.durationMs ?? null)}
                        </span>
                      ) : null}
                    </p>
                    {recording.state === "ready" && !recording.output ? (
                      <p className="flex items-center gap-1 text-xs text-warning"><AlertTriangle aria-hidden="true" className="size-3.5" />Output verification is incomplete; playback remains unavailable.</p>
                    ) : null}
                    {recording.state === "failed" || recording.state === "aborted" ? (
                      <p className="text-xs text-destructive">This attempt did not produce an available recording. Open meeting results for the server-reported reason.</p>
                    ) : null}
                  </div>
                  <Button asChild variant="outline">
                    <Link to={meetingResultsPath(meeting.id)}>
                      {recording.state === "ready" && recording.output ? "Open recording" : "View status"}
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </section>
        </>
      ) : null}
      {!loading && !error && historyHasMore ? (
        <p className="text-xs text-muted-foreground">
          Showing the first history window. Older meetings are available through the Meetings page;
          the current API does not provide a global recordings index.
        </p>
      ) : null}
    </div>
  );
}
