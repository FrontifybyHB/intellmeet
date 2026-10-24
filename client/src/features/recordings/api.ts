// Recording + recording-consent endpoints owned by the recordings feature.
//
// Every call goes through the shared HTTP transport, so cookie transport,
// CSRF bootstrapping and refresh-on-401 behave exactly as they do for the
// other features. The shapes below mirror the server contract in
// server/src/controllers/recordingController.js and
// server/src/services/recordingService.js — nothing here is invented.
//
// Ownership rule (server-enforced): GET/POST /recording-consent read and
// write ONLY the caller's own consent row. The host has no privileged path
// to another participant's consent, and no participant can write anyone
// else's. Start/stop are a separate, host-only pair of endpoints.

import { apiFetch } from "@/shared/api/client";

/** The two recording-consent decisions the server accepts. */
export type ConsentDecision = "approved" | "declined";

/**
 * AI-transfer permission is stored separately from the recording decision
 * and is never inferred from it in either direction.
 */
export type AiTransferDecision = "approved" | "declined" | "undecided";

/** The durable recording lifecycle states the server persists. */
export type RecordingState =
  | "requested"
  | "starting"
  | "active"
  | "stopping"
  | "verifying"
  | "ready"
  | "failed"
  | "aborted"
  | "unknown";

export interface RecordingConsentSnapshot {
  noticeVersion: string;
  approvedCount: number;
  requiredCount: number;
  capturedAt: string | null;
}

export interface Recording {
  id: string;
  meetingId: string;
  sessionId: string;
  providerEgressId: string | null;
  state: RecordingState;
  /** Monotonic version: the server's conditional-transition counter. */
  version: number;
  requesterId: string | null;
  consentSnapshot: RecordingConsentSnapshot | null;
  storage: { bucket: string; key: string; format: string } | null;
  output: { durationMs: number | null; sizeBytes: number | null } | null;
  /** Whitelisted server error code (never a raw provider message). */
  errorCode: string | null;
  providerUpdatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The caller's own consent row. */
export interface ConsentRecord {
  meetingId: string;
  userId: string;
  noticeVersion: string;
  recording: ConsentDecision;
  aiTransfer: AiTransferDecision;
  updatedAt: string | null;
}

export interface ConsentResponse {
  /** The notice version the server currently requires. */
  noticeVersion: string;
  /** The caller's own row, or null when the caller never decided. */
  consent: ConsentRecord | null;
}

/** Start/stop answer: the durable attempt plus whether it already existed. */
export interface RecordingEnvelope {
  recording: Recording;
  /** true when the server resumed an existing attempt instead of creating one. */
  resumed: boolean;
}

export interface RecordingListResponse {
  recordings: Recording[];
  /**
   * The list endpoint is newest-first and windowed by `limit`. The server
   * exposes no next cursor, so `hasMore` means "older recordings exist that
   * this response cannot address" — there is no second page to fetch.
   */
  hasMore: boolean;
}

/** A short-lived, freshly minted access link for a ready recording. */
export interface RecordingAccessLink {
  url: string;
  expiresAt: string;
}

/** Reads the caller's own consent row plus the current notice version. */
export function fetchRecordingConsent(meetingId: string): Promise<ConsentResponse> {
  return apiFetch<ConsentResponse>(`/meetings/${meetingId}/recording-consent`, {
    cache: "no-store",
  });
}

/**
 * Records the caller's own decision. `noticeVersion` must echo the version
 * the server currently requires: a stale version is rejected with 409
 * NOTICE_VERSION_MISMATCH and the notice has to be read again.
 */
export function saveRecordingConsent({
  meetingId,
  decision,
  noticeVersion,
  aiTransfer,
}: {
  meetingId: string;
  decision: ConsentDecision;
  noticeVersion: string;
  aiTransfer?: AiTransferDecision;
}): Promise<{ consent: ConsentRecord }> {
  return apiFetch<{ consent: ConsentRecord }>(
    `/meetings/${meetingId}/recording-consent`,
    {
      method: "POST",
      body: { decision, noticeVersion, aiTransfer },
      cache: "no-store",
    },
  );
}

/** Starts a recording (host only; the server enforces NOT_HOST). */
export function startMeetingRecording(meetingId: string): Promise<RecordingEnvelope> {
  return apiFetch<RecordingEnvelope>(`/meetings/${meetingId}/recordings/start`, {
    method: "POST",
    body: {},
    cache: "no-store",
  });
}

/** Stops a recording (host only; idempotent on the server). */
export function stopMeetingRecording(
  meetingId: string,
  recordingId: string,
): Promise<RecordingEnvelope> {
  return apiFetch<RecordingEnvelope>(
    `/meetings/${meetingId}/recordings/${recordingId}/stop`,
    { method: "POST", body: {}, cache: "no-store" },
  );
}

/** Lists the meeting's recordings, newest first, windowed by `limit`. */
export function listMeetingRecordings(
  meetingId: string,
  limit: number,
): Promise<RecordingListResponse> {
  return apiFetch<RecordingListResponse>(
    `/meetings/${meetingId}/recordings?limit=${limit}`,
    { cache: "no-store" },
  );
}

/** Reads one recording (authoritative recovery read). */
export function fetchMeetingRecording(
  meetingId: string,
  recordingId: string,
): Promise<{ recording: Recording }> {
  return apiFetch<{ recording: Recording }>(
    `/meetings/${meetingId}/recordings/${recordingId}`,
    { cache: "no-store" },
  );
}

/**
 * Mints a short-lived access link for a ready recording. The link is never
 * stored by this client — it is held in memory for the lifetime of the
 * playback view and re-minted when it expires.
 */
export function fetchRecordingAccessLink(
  meetingId: string,
  recordingId: string,
): Promise<RecordingAccessLink> {
  return apiFetch<RecordingAccessLink>(
    `/meetings/${meetingId}/recordings/${recordingId}/url`,
    { cache: "no-store" },
  );
}

/**
 * Extracts the durable attempt the server attaches to a failed start.
 *
 * When the provider times out the outcome is UNKNOWN, not failure: the
 * attempt may still exist, so the server returns it alongside the error.
 * The client merges it instead of assuming nothing was created.
 */
export function recordingFromErrorBody(err: unknown): Recording | null {
  if (!err || typeof err !== "object") return null;
  const body = (err as { body?: unknown }).body;
  if (!body || typeof body !== "object") return null;
  const candidate = (body as { recording?: unknown }).recording;
  if (!candidate || typeof candidate !== "object") return null;
  const recording = candidate as Partial<Recording>;
  if (typeof recording.id !== "string" || typeof recording.state !== "string") {
    return null;
  }
  return recording as Recording;
}
