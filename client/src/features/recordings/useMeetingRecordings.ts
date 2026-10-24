// Data hook for the recording surface of one meeting.
//
// It owns four things that must not drift apart:
//
// 1. The caller's OWN consent row (server-owned; the client only ever
//    writes its own row).
// 2. The meeting's recordings, newest first.
// 3. Live updates from the server's `recording:status` / `recording:ready`
//    events, merged with authoritative HTTP reads so a missed event can
//    never leave the UI stale.
// 4. Bounded reconciliation polling: a fallback for environments where the
//    socket cannot connect. The budget is hard-capped, so polling always
//    terminates.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, describeApiError } from "@/shared/api/errors";
import {
  connectMeetingSocket,
  type RecordingStatusEvent,
} from "@/shared/realtime/meetingSocket";
import {
  fetchMeetingRecording,
  fetchRecordingConsent,
  listMeetingRecordings,
  recordingFromErrorBody,
  saveRecordingConsent,
  startMeetingRecording,
  stopMeetingRecording,
  type AiTransferDecision,
  type ConsentDecision,
  type ConsentResponse,
  type Recording,
} from "@/features/recordings/api";
import {
  canStopRecording,
  isNonterminalRecordingState,
  liveRecording,
  mergeRecording,
  mergeRecordingList,
} from "@/features/recordings/state";

export interface MeetingRecordingsOptions {
  meetingId: string;
  /** How many recordings the list window may contain. */
  limit?: number;
  /** Reconciliation poll interval. */
  pollIntervalMs?: number;
  /** Hard cap on consecutive reconciliation polls per live attempt. */
  maxPollAttempts?: number;
  /** Set to false to stay idle (e.g. before the meeting is known). */
  enabled?: boolean;
}

export interface MeetingRecordings {
  consent: ConsentResponse | null;
  recordings: Recording[];
  hasMore: boolean;
  loading: boolean;
  loadError: string | null;
  /** The last failed action, with the server's error code preserved. */
  actionError: RecordingFailure | null;
  /** True after the server rejected the decision because the notice moved on. */
  noticeChanged: boolean;
  busy: "consent" | "start" | "stop" | null;
  liveConnected: boolean;
  /** True when the bounded poll budget is exhausted. */
  pollingStopped: boolean;
  refresh: () => Promise<void>;
  saveConsent: (decision: ConsentDecision, aiTransfer: AiTransferDecision) => Promise<void>;
  start: () => Promise<void>;
  stop: (recordingId: string) => Promise<void>;
  clearActionError: () => void;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 24;

/** A failed action: the server's code plus a message for the user. */
export interface RecordingFailure {
  code: string;
  message: string;
  /** Which control produced the failure, so the panel can show it there. */
  source: "consent" | "start" | "stop";
}

function toFailure(
  err: unknown,
  fallback: string,
  source: RecordingFailure["source"],
): RecordingFailure {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message || fallback, source };
  }
  if (err instanceof Error && err.message) {
    return { code: "UNKNOWN", message: err.message, source };
  }
  return { code: "UNKNOWN", message: fallback, source };
}

export function useMeetingRecordings({
  meetingId,
  limit = DEFAULT_LIMIT,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
  enabled = true,
}: MeetingRecordingsOptions): MeetingRecordings {
  const [consent, setConsent] = useState<ConsentResponse | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<RecordingFailure | null>(null);
  const [noticeChanged, setNoticeChanged] = useState(false);
  const [busy, setBusy] = useState<"consent" | "start" | "stop" | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);

  const busyRef = useRef(false);
  const recordingsRef = useRef<Recording[]>([]);
  recordingsRef.current = recordings;

  const loadConsent = useCallback(async () => {
    const body = await fetchRecordingConsent(meetingId);
    setConsent(body);
    return body;
  }, [meetingId]);

  const refresh = useCallback(async () => {
    try {
      const body = await listMeetingRecordings(meetingId, limit);
      setRecordings((current) => mergeRecordingList(current, body.recordings));
      setHasMore(body.hasMore);
      setLoadError(null);
    } catch (err) {
      setLoadError(describeApiError(err, "Could not load recordings."));
    }
  }, [meetingId, limit]);

  // Initial load: own consent + the recording window.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [, ] = await Promise.all([loadConsent(), refresh()]);
        if (!cancelled) setLoadError(null);
      } catch (err) {
        if (!cancelled) {
          setLoadError(describeApiError(err, "Could not load the recording status."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, loadConsent, refresh]);

  // Recovery read for an event about a recording this client has not seen
  // (evicted client, event that arrived before the list load finished).
  const recoverRecording = useCallback(
    async (recordingId: string) => {
      try {
        const body = await fetchMeetingRecording(meetingId, recordingId);
        setRecordings((current) => mergeRecording(current, body.recording));
      } catch {
        // The recording may have been removed with its meeting; the next
        // list refresh reconciles it.
      }
    },
    [meetingId],
  );

  const handleStatusEvent = useCallback(
    (event: RecordingStatusEvent) => {
      if (event.meetingId !== meetingId) return;
      const known = recordingsRef.current.some((row) => row.id === event.recording.id);
      // The event carries server-authoritative state, so it is merged right
      // away: a missed event must never leave the UI behind.
      setRecordings((current) => mergeRecording(current, event.recording));
      if (!known) {
        // A recording this client has not seen yet: reconcile with the
        // authoritative read so the list matches the server exactly.
        void recoverRecording(event.recording.id);
      }
    },
    [meetingId, recoverRecording],
  );

  // Live events. The socket is opened once per meeting; the handlers are
  // read through a ref so a re-render never reconnects the socket.
  const handlersRef = useRef({ handleStatusEvent, recoverRecording, meetingId });
  handlersRef.current = { handleStatusEvent, recoverRecording, meetingId };

  useEffect(() => {
    if (!enabled || !meetingId) return;
    const teardown = connectMeetingSocket(meetingId, {
      onRecordingStatus: (event) => handlersRef.current.handleStatusEvent(event),
      onRecordingReady: (event) => {
        // The ready event carries no recording body: the authoritative
        // state comes from the bounded read, never from the event alone.
        void handlersRef.current.recoverRecording(event.recordingId);
      },
      onConnected: () => setLiveConnected(true),
      onDisconnected: () => setLiveConnected(false),
    });
    return teardown;
  }, [enabled, meetingId]);

  // Bounded reconciliation poll. Runs only while an attempt is in flight and
  // stops after the budget is spent, so polling is never unbounded.
  const liveKey = useMemo(
    () =>
      recordings
        .filter((row) => isNonterminalRecordingState(row.state))
        .map((row) => row.id)
        .join(","),
    [recordings],
  );

  useEffect(() => {
    if (!enabled || !liveKey) {
      setPollingStopped(false);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;

    const schedule = () => {
      timer = window.setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          attempts += 1;
          if (attempts > maxPollAttempts) {
            setPollingStopped(true);
            return;
          }
          await refresh();
          if (cancelled) return;
          schedule();
        })();
      }, pollIntervalMs);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, liveKey, pollIntervalMs, maxPollAttempts, refresh]);

  const saveConsent = useCallback(
    async (decision: ConsentDecision, aiTransfer: AiTransferDecision) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy("consent");
      setActionError(null);
      try {
        const current = consent ?? (await loadConsent());
        const body = await saveRecordingConsent({
          meetingId,
          decision,
          noticeVersion: current.noticeVersion,
          aiTransfer,
        });
        setConsent((previous) =>
          previous
            ? { ...previous, consent: body.consent }
            : { noticeVersion: current.noticeVersion, consent: body.consent },
        );
        setNoticeChanged(false);
      } catch (err) {
        if (err instanceof ApiError && err.code === "NOTICE_VERSION_MISMATCH") {
          // The notice moved on: read the new one and make the user decide
          // again. The decision is never carried over silently.
          try {
            await loadConsent();
          } catch {
            // The re-read failure is reported by the generic branch below.
          }
          setNoticeChanged(true);
          setActionError({
            code: "NOTICE_VERSION_MISMATCH",
            message:
              "The recording notice changed. Review the current notice and decide again.",
            source: "consent",
          });
        } else {
          setActionError(toFailure(err, "Could not save your consent.", "consent"));
        }
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [consent, loadConsent, meetingId],
  );

  const start = useCallback(async () => {
    if (busyRef.current) return;
    // Never send a second start while an attempt is already in flight: the
    // server would resume the existing attempt, but the user should not be
    // told a new recording started.
    if (liveRecording(recordingsRef.current)) return;
    busyRef.current = true;
    setBusy("start");
    setActionError(null);
    try {
      const body = await startMeetingRecording(meetingId);
      setRecordings((current) => mergeRecording(current, body.recording));
      if (body.resumed) {
        setActionError({
          code: "RECORDING_RESUMED",
          message: "A recording attempt was already in progress, so the existing one was resumed.",
          source: "start",
        });
      }
    } catch (err) {
      // The attempt may still exist (a provider timeout leaves a durable
      // attempt behind and the server attaches it to the error): merge it
      // instead of pretending nothing happened, and reconcile with the
      // authoritative read when the server sent no attempt.
      const attached = recordingFromErrorBody(err);
      if (attached) {
        setRecordings((current) => mergeRecording(current, attached));
      } else {
        await refresh();
      }
      setActionError(toFailure(err, "Could not start the recording.", "start"));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [meetingId, refresh]);

  const stop = useCallback(
    async (recordingId: string) => {
      if (busyRef.current) return;
      // A stop for an attempt that is already stopping, verifying or
      // final is a server no-op: never send it.
      const current = recordingsRef.current.find((row) => row.id === recordingId);
      if (current && !canStopRecording(current.state)) return;
      busyRef.current = true;
      setBusy("stop");
      setActionError(null);
      try {
        const body = await stopMeetingRecording(meetingId, recordingId);
        setRecordings((current) => mergeRecording(current, body.recording));
      } catch (err) {
        await refresh();
        setActionError(toFailure(err, "Could not stop the recording.", "stop"));
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [meetingId, refresh],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return {
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
  };
}
