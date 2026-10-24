// Pure recording-state helpers.
//
// These functions translate the server's durable recording states into what
// the product shows. They are deliberately free of React and of the network
// so the mapping can be unit-tested on its own.
//
// The server owns the state machine (server/src/constants/recordingLimits.js):
// terminal states never regress and every transition is version-checked. The
// helpers below mirror that contract instead of inventing a second one.

import type { Recording, RecordingState } from "@/features/recordings/api";

/** States the server never leaves. */
export const TERMINAL_RECORDING_STATES: RecordingState[] = ["ready", "failed", "aborted"];

/** States where a capture attempt is still in flight. */
export const NONTERMINAL_RECORDING_STATES: RecordingState[] = [
  "requested",
  "starting",
  "active",
  "stopping",
  "verifying",
  "unknown",
];

export function isTerminalRecordingState(state: RecordingState): boolean {
  return TERMINAL_RECORDING_STATES.includes(state);
}

export function isNonterminalRecordingState(state: RecordingState): boolean {
  return NONTERMINAL_RECORDING_STATES.includes(state);
}

/**
 * The phase the product shows for a durable state. `unknown` is deliberately
 * its own phase: the provider did not answer, so the attempt is neither
 * running nor failed and must not be presented as either.
 */
export type RecordingPhase =
  | "pending"
  | "starting"
  | "recording"
  | "stopping"
  | "verifying"
  | "ready"
  | "failed"
  | "aborted"
  | "unknown";

export function recordingPhase(state: RecordingState): RecordingPhase {
  switch (state) {
    case "requested":
      return "pending";
    case "starting":
      return "starting";
    case "active":
      return "recording";
    case "stopping":
      return "stopping";
    case "verifying":
      return "verifying";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

const PHASE_LABELS: Record<RecordingPhase, string> = {
  pending: "Pending",
  starting: "Starting",
  recording: "Recording",
  stopping: "Stopping",
  verifying: "Verifying output",
  ready: "Ready",
  failed: "Failed",
  aborted: "Aborted",
  unknown: "Reconciling",
};

export function recordingPhaseLabel(state: RecordingState): string {
  return PHASE_LABELS[recordingPhase(state)];
}

/**
 * Human explanations for the server's whitelisted error codes. A provider or
 * storage configuration problem is reported as exactly that: an integration
 * blocker on the server, never as a product failure and never as success.
 */
const ERROR_MESSAGES: Record<string, string> = {
  PROVIDER_START_FAILED:
    "The recording provider refused to start the capture. No recording was created.",
  PROVIDER_STOP_FAILED:
    "The provider did not confirm the stop. The attempt stays in stopping and is reconciled by the server.",
  PROVIDER_TIMEOUT_UNKNOWN:
    "The provider did not answer in time. The attempt is being reconciled — it may still exist, so do not start another one.",
  PROVIDER_FAILED: "The recording provider failed during the capture.",
  PROVIDER_LIMIT_REACHED:
    "The provider's concurrent-recording limit was reached. This attempt failed; the limit is enforced by the provider.",
  PROVIDER_ABORTED: "The provider aborted the recording.",
  CONSENT_WITHDRAWN:
    "A participant withdrew consent, so the capture was quarantined and the output will never be published.",
  CONSENT_MISSING: "Consent was missing when the capture was requested.",
  MEETING_ENDED: "The meeting ended before the recording completed.",
  OUTPUT_MISSING:
    "The provider finished but no output file was found in the configured storage, so the recording failed.",
  OUTPUT_INVALID: "The configured storage location for the recording was rejected.",
  INTEGRATION_BLOCKER:
    "Recording is not configured on the server (provider or storage). Nothing was recorded.",
  DB_ERROR: "The recording could not be stored.",
};

export function recordingErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code] ?? `The recording ended with error ${code}.`;
}

/** True when the error code means the server-side provider/storage is missing. */
export function isIntegrationBlocker(code: string | null): boolean {
  return code === "INTEGRATION_BLOCKER";
}

/**
 * True while a stop request still means something. The server only
 * transitions to stopping from these states; a request for an attempt that
 * is already stopping or verifying would be a no-op, so the UI does not
 * offer it.
 */
export function canStopRecording(state: RecordingState): boolean {
  return (
    state === "requested" ||
    state === "starting" ||
    state === "active" ||
    state === "unknown"
  );
}

/**
 * Merges an incoming recording into a list, newest-first, without ever
 * regressing a state the server already finalised.
 *
 * The version counter is the server's conditional-transition counter, so an
 * event with a lower version is stale and is dropped. Terminal states are
 * kept even when a later event carries a higher version, because the server
 * guarantees terminal states never regress.
 */
export function mergeRecording(
  recordings: Recording[],
  incoming: Recording,
): Recording[] {
  const index = recordings.findIndex((row) => row.id === incoming.id);
  if (index === -1) {
    return [incoming, ...recordings];
  }
  const current = recordings[index];
  if (isTerminalRecordingState(current.state)) {
    return recordings;
  }
  if (typeof incoming.version === "number" && incoming.version < current.version) {
    return recordings;
  }
  const next = recordings.slice();
  next[index] = incoming;
  return next;
}

/**
 * Reconciles a list response without letting a slower HTTP read regress a
 * newer socket/action update already shown in the UI.
 */
export function mergeRecordingList(
  current: Recording[],
  incoming: Recording[],
): Recording[] {
  let merged: Recording[] = [];
  for (const recording of incoming) merged = mergeRecording(merged, recording);
  for (const recording of current) merged = mergeRecording(merged, recording);
  return merged;
}

/** The most recent attempt that is still in flight, if any. */
export function liveRecording(recordings: Recording[]): Recording | null {
  for (const row of recordings) {
    if (isNonterminalRecordingState(row.state)) return row;
  }
  return null;
}

/** The newest attempt overall (the list is newest-first). */
export function latestRecording(recordings: Recording[]): Recording | null {
  return recordings.length > 0 ? recordings[0] : null;
}

/** Formats a duration in milliseconds as a short human string. */
export function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

/** Formats a byte count for display. */
export function formatBytes(sizeBytes: number | null): string | null {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return null;
  }
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
