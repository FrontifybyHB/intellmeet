// The recording surface of a meeting.
//
// Three blocks, three different audiences:
//
// 1. Consent — EVERY participant. It shows and changes the caller's OWN
//    consent row only. There is deliberately no way to answer for somebody
//    else, and the host gets no privileged control here.
// 2. Host controls — the host only. Start/stop are server-enforced; the UI
//    merely reflects what the server allows.
// 3. The recording list — everyone entitled to see this meeting's history,
//    with playback that mints a short-lived link on demand.
//
// Nothing in this component invents recording state: every value shown
// comes from the server, and a failure is reported as a failure.

import { useMemo, useState } from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  Loader2Icon,
  RefreshCwIcon,
  SquareIcon,
  VideoIcon,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import { PlayRecordingButton } from "@/features/recordings/RecordingPlayback";
import type { AiTransferDecision, Recording } from "@/features/recordings/api";
import { useMeetingRecordings } from "@/features/recordings/useMeetingRecordings";
import {
  canStopRecording,
  formatBytes,
  formatDuration,
  isIntegrationBlocker,
  latestRecording,
  liveRecording,
  recordingErrorMessage,
  recordingPhase,
  recordingPhaseLabel,
} from "@/features/recordings/state";

interface RecordingPanelProps {
  meetingId: string;
  /** Server-resolved meeting capability; never inferred in this component. */
  isHost: boolean;
  canRecord?: boolean;
  selectedRecordingId?: string | null;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function stateBadgeVariant(
  state: Recording["state"],
): "default" | "secondary" | "destructive" | "outline" {
  switch (recordingPhase(state)) {
    case "ready":
      return "default";
    case "failed":
    case "aborted":
      return "destructive";
    case "recording":
      return "secondary";
    default:
      return "outline";
  }
}

export function RecordingPanel({
  meetingId,
  isHost,
  canRecord = isHost,
  selectedRecordingId,
}: RecordingPanelProps) {
  const {
    consent,
    recordings,
    hasMore,
    loading,
    loadError,
    actionError,
    noticeChanged,
    busy,
    liveConnected,
    pollingStopped,
    refresh,
    saveConsent,
    start,
    stop,
    clearActionError,
  } = useMeetingRecordings({ meetingId });

  const [aiBusy, setAiBusy] = useState(false);

  const ownConsent = consent?.consent ?? null;
  const noticeVersion = consent?.noticeVersion ?? null;
  const live = useMemo(() => liveRecording(recordings), [recordings]);
  const newest = useMemo(() => latestRecording(recordings), [recordings]);

  const recordingDecision = ownConsent?.recording ?? null;
  const aiTransfer = ownConsent?.aiTransfer ?? "undecided";

  const saveRecordingDecision = async (decision: "approved" | "declined") => {
    // The server replaces both fields on every consent write, so the
    // current AI-transfer answer is sent along: changing the recording
    // decision must never silently reset it.
    await saveConsent(decision, aiTransfer);
  };

  const saveAiTransfer = async (decision: AiTransferDecision) => {
    if (!recordingDecision) return;
    setAiBusy(true);
    try {
      await saveConsent(recordingDecision, decision);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Your recording consent</CardTitle>
          <CardDescription>
            Recording can only start when every participant has approved the current notice. Your
            choice applies to you alone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Notice version</span>
            <Badge variant="outline">{noticeVersion ?? "—"}</Badge>
            {recordingDecision === "approved" ? (
              <Badge data-testid="consent-recording-state">
                <CircleCheckIcon aria-hidden="true" />
                You approved recording
              </Badge>
            ) : recordingDecision === "declined" ? (
              <Badge variant="destructive" data-testid="consent-recording-state">
                <CircleSlashIcon aria-hidden="true" />
                You declined recording
              </Badge>
            ) : (
              <Badge variant="outline" data-testid="consent-recording-state">
                No decision yet
              </Badge>
            )}
          </div>

          {noticeChanged ? (
            <p className="text-sm text-muted-foreground" data-testid="consent-notice-changed">
              The notice changed since you last decided. Review it and decide again.
            </p>
          ) : null}

          {actionError && actionError.source === "consent" ? (
            <ErrorState
              title="Consent was not saved"
              message={`${actionError.code}: ${actionError.message}`}
              action={
                <Button variant="outline" size="sm" onClick={clearActionError}>
                  Dismiss
                </Button>
              }
            />
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void saveRecordingDecision("approved")}
              disabled={busy === "consent"}
              data-testid="consent-approve"
            >
              {busy === "consent" ? (
                <Loader2Icon aria-hidden="true" className="animate-spin" />
              ) : null}
              Allow recording
            </Button>
            <Button
              variant="outline"
              onClick={() => void saveRecordingDecision("declined")}
              disabled={busy === "consent"}
              data-testid="consent-decline"
            >
              <CircleSlashIcon aria-hidden="true" />
              Don&apos;t allow recording
            </Button>
          </div>

          {recordingDecision === "approved" ? (
            <p className="text-xs text-muted-foreground">
              Declining now stops any capture in progress and quarantines the output so it is never
              published.
            </p>
          ) : null}

          <div className="space-y-2 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">AI processing of your audio</span>
              <Badge variant="outline" data-testid="consent-ai-state">
                {aiTransfer === "approved"
                  ? "Allowed"
                  : aiTransfer === "declined"
                    ? "Not allowed"
                    : "Not decided"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Stored separately from recording acknowledgement and never inferred from it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void saveAiTransfer("approved")}
                disabled={aiBusy || busy === "consent"}
                data-testid="consent-ai-approve"
              >
                Allow AI processing
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void saveAiTransfer("declined")}
                disabled={aiBusy || busy === "consent"}
                data-testid="consent-ai-decline"
              >
                Don&apos;t allow
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void saveAiTransfer("undecided")}
                disabled={aiBusy || busy === "consent"}
                data-testid="consent-ai-reset"
              >
                Leave undecided
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {canRecord ? (
        <Card data-testid="host-recording-controls">
          <CardHeader>
            <CardTitle>{isHost ? "Owner controls" : "Recording controls"}</CardTitle>
            <CardDescription>
              Only the meeting host can start or stop recording. Participants are notified and
              may independently choose whether their content can be used for AI processing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {live ? (
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="secondary" data-testid="live-recording-state">
                  {recordingPhaseLabel(live.state)}
                </Badge>
                <span className="text-sm text-muted-foreground">Attempt {live.id}</span>
                <Button
                  variant="outline"
                  onClick={() => void stop(live.id)}
                  disabled={busy === "stop" || !canStopRecording(live.state)}
                  data-testid="stop-recording"
                >
                  {busy === "stop" ? (
                    <Loader2Icon aria-hidden="true" className="animate-spin" />
                  ) : (
                    <SquareIcon aria-hidden="true" />
                  )}
                  Stop recording
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void start()}
                  disabled={busy === "start"}
                  data-testid="start-recording"
                >
                  {busy === "start" ? (
                    <Loader2Icon aria-hidden="true" className="animate-spin" />
                  ) : (
                    <VideoIcon aria-hidden="true" />
                  )}
                  Start recording
                </Button>
                {newest ? (
                  <span className="text-sm text-muted-foreground">
                    Last attempt: {recordingPhaseLabel(newest.state)}
                  </span>
                ) : null}
              </div>
            )}

            {actionError && actionError.source !== "consent" ? (
              <ErrorState
                title={
                  isIntegrationBlocker(actionError.code)
                    ? "Recording is not configured on the server"
                    : "Recording action failed"
                }
                message={
                  isIntegrationBlocker(actionError.code)
                    ? `${actionError.message} Nothing was recorded. This is a server configuration gap, not a client one.`
                    : `${actionError.code}: ${actionError.message}`
                }
                action={
                  <Button variant="outline" size="sm" onClick={clearActionError}>
                    Dismiss
                  </Button>
                }
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recordings</CardTitle>
          <CardDescription>
            {liveConnected
              ? "Live updates are connected."
              : "Live updates are not connected, so this list is refreshed periodically."}
          </CardDescription>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
              data-testid="refresh-recordings"
            >
              <RefreshCwIcon aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {pollingStopped ? (
            <p className="text-sm text-muted-foreground" data-testid="polling-stopped">
              Automatic refreshing stopped after the reconciliation limit. Use Refresh to check
              again.
            </p>
          ) : null}

          {loading ? <LoadingState label="Loading recordings…" /> : null}

          {!loading && loadError ? (
            <ErrorState
              title="Recordings unavailable"
              message={loadError}
              action={
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  Try again
                </Button>
              }
            />
          ) : null}

          {!loading && !loadError && recordings.length === 0 ? (
            <EmptyState
              icon={VideoIcon}
              title="No recordings yet"
              description="Recordings appear here once a capture has been started and finished."
            />
          ) : null}

          {!loading && recordings.length > 0 ? (
            <ul className="space-y-3" data-testid="recording-list">
              {recordings.map((recording) => {
                const errorMessage = recordingErrorMessage(recording.errorCode);
                const duration = formatDuration(recording.output?.durationMs ?? null);
                const size = formatBytes(recording.output?.sizeBytes ?? null);
                return (
                  <li
                    key={recording.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
                    data-testid="recording-row"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={stateBadgeVariant(recording.state)}>
                          {recordingPhaseLabel(recording.state)}
                        </Badge>
                        <span className="truncate text-sm text-muted-foreground">
                          {formatTimestamp(recording.createdAt)}
                        </span>
                        {duration ? (
                          <span className="text-sm text-muted-foreground">{duration}</span>
                        ) : null}
                        {size ? (
                          <span className="text-sm text-muted-foreground">{size}</span>
                        ) : null}
                      </div>
                      {errorMessage ? (
                        <p className="flex items-start gap-1.5 text-sm text-destructive">
                          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                          <span>{errorMessage}</span>
                        </p>
                      ) : null}
                    </div>
                    {recording.state === "ready" ? (
                      <PlayRecordingButton
                        meetingId={meetingId}
                        recordingId={recording.id}
                        autoOpen={recording.id === selectedRecordingId}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {hasMore ? (
            <p className="text-xs text-muted-foreground" data-testid="recordings-truncated">
              This list shows the most recent recordings only. Older recordings exist, but the API
              does not expose a way to page back to them yet.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
