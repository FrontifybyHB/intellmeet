"use strict";

// Centralized Phase 4 transcription contracts.
//
// Eligibility (all required, fail closed):
// - meeting status === "ended" (post-meeting only);
// - recording state === "ready" with trusted private output
//   (Phase 3 verified output, never a client/webhook URL);
// - recording.consentRevoked !== true (quarantined output blocked);
// - explicit Google audio-transfer consent (aiTransfer === "approved")
//   at the CURRENT notice version for every captured human: the live
//   required set (host + admitted) must each hold an approving row,
//   AND every historical consent row for the meeting must approve
//   (a removed participant's later decline still blocks — mixed audio
//   cannot reliably redact one speaker).
// Recording-only consent is insufficient.
//
// Run identity: recordingId + immutable source version (storage
// bucket/key/format + providerEgressId + recording output snapshot)
// + PIPELINE/MODEL/PROMPT/SCHEMA versions. A source, model, or prompt
// change yields a NEW run; stale chunks/results never mix.
//
// Run states: pending_enqueue -> queued -> running -> complete, with
// retrying (worker-owned transient), blocked (eligibility), failed,
// cancelled (terminal). Transitions are conditional version-checked
// writes on the transcription subdocument (Recording.transcription.
// version + runId fence). A terminal run is superseded only by a NEW
// runId+runVersion — never resurrected or mutated in place.
//
// In-flight external race (documented, not hidden): once audio bytes
// leave for Google, local cancellation cannot unsend them. Cancel
// prevents future calls, suppresses publication of late results, and
// requests remote cleanup where the API supports it — it never claims
// remote processing/retention instantly ceased.
const TRANSCRIPTION_STATES = {
  PENDING_ENQUEUE: "pending_enqueue",
  QUEUED: "queued",
  RUNNING: "running",
  RETRYING: "retrying",
  COMPLETE: "complete",
  FAILED: "failed",
  CANCELLED: "cancelled",
  BLOCKED: "blocked",
};

const TERMINAL_TRANSCRIPTION_STATES = [
  TRANSCRIPTION_STATES.COMPLETE,
  TRANSCRIPTION_STATES.FAILED,
  TRANSCRIPTION_STATES.CANCELLED,
  TRANSCRIPTION_STATES.BLOCKED,
];

// Legal conditional transitions. Absent edges are rejected. A terminal
// run is never resurrected: the failed/cancelled/blocked outgoing
// edges exist ONLY to supersede with a NEW runId+runVersion (the fence
// binds the old runId, so stale workers of the previous run cannot
// write), and publication still requires full re-validation.
const TRANSCRIPTION_TRANSITIONS = {
  pending_enqueue: ["queued", "blocked", "cancelled", "failed"],
  queued: ["running", "cancelled", "blocked", "failed"],
  running: ["retrying", "complete", "failed", "cancelled", "blocked"],
  retrying: ["running", "complete", "failed", "cancelled", "blocked"],
  complete: ["pending_enqueue", "blocked"],
  failed: ["pending_enqueue", "blocked"],
  cancelled: ["pending_enqueue", "blocked"],
  blocked: ["pending_enqueue", "blocked"],
};

// Pipeline identity versions, persisted on every run. Bump the prompt
// version when instructions change, the schema version when the
// segment contract changes, and the pipeline version on orchestration
// changes. A run only publishes chunks produced under its own versions.
const TRANSCRIPTION_VERSIONS = {
  PIPELINE: "t1",
  PROMPT: "p1",
  SCHEMA: "s1",
};

// Safe, whitelisted terminal failure/block codes persisted on runs.
// Provider messages are never stored verbatim.
const TRANSCRIPTION_ERROR_CODES = new Set([
  "CONSENT_BLOCKED",
  "CONSENT_WITHDRAWN",
  "TRANSFER_CONSENT_MISSING",
  "RECORDING_NOT_READY",
  "OUTPUT_MISSING",
  "OUTPUT_INVALID",
  "MEETING_NOT_ENDED",
  "MEETING_NOT_FOUND",
  "NOT_HOST",
  "AUDIO_TOO_LARGE",
  "AUDIO_TOO_LONG",
  "AUDIO_FORMAT_UNSUPPORTED",
  "EXTRACTION_UNAVAILABLE",
  "NO_AUDIO",
  "STORAGE_UNAVAILABLE",
  "INTEGRATION_BLOCKER",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_FAILED",
  "PROVIDER_FILE_EXPIRED",
  "OUTPUT_TRUNCATED",
  "OUTPUT_MALFORMED",
  "OUTPUT_SAFETY_BLOCKED",
  "OUTPUT_INCOMPLETE",
  "SCHEMA_INVALID",
  "RUN_SUPERSEDED",
  "CANCELLED",
  "DB_ERROR",
]);

// Errors safe to retry inside the bounded attempt budget.
const RETRYABLE_TRANSCRIPTION_ERRORS = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "DB_ERROR",
]);

const TRANSCRIPTION_LIMITS = {
  // Gemini model for audio transcription via generateContent +
  // responseSchema structured output. Documented audio understanding:
  // https://ai.google.dev/gemini-api/docs/audio
  // Structured output: https://ai.google.dev/gemini-api/docs/structured-output
  // Dedicated gemini-3.5-transcribe returns unstructured prose, which
  // does not satisfy the machine-validated segment contract, so the
  // structured-output path is used. Overridable; any change starts a
  // new run version (old results never mix).
  GEMINI_MODEL_DEFAULT: "gemini-2.0-flash",
  GEMINI_MODEL_MAX: 64,
  // Audio accepted directly by the worker without an extractor:
  // linear PCM WAV only (parsed/sliced in-process, no subprocess).
  // Container formats (mp4/m4a/...) require an extractor that is not
  // installed here -> BLOCKED with EXTRACTION_UNAVAILABLE, never
  // fabricated. Supported Gemini audio MIME types:
  // https://ai.google.dev/gemini-api/docs/audio
  WAV_MIME_TYPES: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  SUPPORTED_AUDIO_MIME_TYPES: [
    "audio/wav",
    "audio/x-wav",
    "audio/mp3",
    "audio/mpeg",
    "audio/aiff",
    "audio/aac",
    "audio/ogg",
    "audio/flac",
    "audio/m4a",
    "audio/opus",
    "audio/webm",
  ],
  // Single provider call budget (conservative vs the 9.5h input max:
  // output budget, not input acceptance, is the binding constraint).
  CHUNK_MS_DEFAULT: 300000,
  CHUNK_MS_MIN: 30000,
  CHUNK_MS_MAX: 900000,
  // Chunk overlap is acoustic context for boundary speech; OUTPUT
  // responsibility never overlaps (each millisecond is published by
  // exactly one chunk, time-ruled, never text-matched), so overlap
  // cannot duplicate speech. Boundary words cut at a chunk edge may
  // lose their tail in the published transcript.
  OVERLAP_MS_DEFAULT: 2000,
  OVERLAP_MS_MIN: 0,
  OVERLAP_MS_MAX: 15000,  MAX_CHUNKS_DEFAULT: 24,
  MAX_CHUNKS_MIN: 1,
  MAX_CHUNKS_MAX: 48,
  // Segment/text bounds.
  SEGMENT_TEXT_MAX_DEFAULT: 2000,
  MAX_SEGMENTS_PER_CHUNK_DEFAULT: 200,
  MAX_SEGMENTS_TOTAL_DEFAULT: 2000,
  // Bytes/duration admission bounds for one source.
  MAX_AUDIO_BYTES_DEFAULT: 262144000,
  MAX_AUDIO_BYTES_MIN: 1048576,
  MAX_AUDIO_BYTES_MAX: 1073741824,
  MAX_AUDIO_MS_DEFAULT: 7200000,
  MAX_AUDIO_MS_MIN: 60000,
  MAX_AUDIO_MS_MAX: 34200000,
  // Queue/worker bounds. Worker concurrency starts at 2; tune from
  // measured evidence only.
  QUEUE_NAME: "intellmeet-transcription",
  WORKER_CONCURRENCY_DEFAULT: 2,
  WORKER_CONCURRENCY_MIN: 1,
  WORKER_CONCURRENCY_MAX: 16,
  QUEUE_MAX_WAITING_DEFAULT: 500,
  QUEUE_MAX_WAITING_MIN: 1,
  QUEUE_MAX_WAITING_MAX: 10000,
  JOB_ATTEMPTS_DEFAULT: 5,
  JOB_ATTEMPTS_MIN: 1,
  JOB_ATTEMPTS_MAX: 10,
  BACKOFF_BASE_MS_DEFAULT: 2000,
  BACKOFF_BASE_MS_MIN: 250,
  BACKOFF_BASE_MS_MAX: 60000,
  // Per-step deadline (one provider call/poll round) and total run cap.
  STEP_TIMEOUT_MS_DEFAULT: 120000,
  STEP_TIMEOUT_MS_MIN: 15000,
  STEP_TIMEOUT_MS_MAX: 600000,
  RUN_TIMEOUT_MS_DEFAULT: 1800000,
  RUN_TIMEOUT_MS_MIN: 120000,
  RUN_TIMEOUT_MS_MAX: 7200000,
  // Cluster-wide provider call budget per day (Redis INCR+EXPIRE
  // counter shared by all workers; jobs/sec limiting alone cannot
  // enforce token/day spend).
  MAX_CALLS_PER_DAY_DEFAULT: 500,
  MAX_CALLS_PER_DAY_MIN: 1,
  MAX_CALLS_PER_DAY_MAX: 100000,
  // Provider Files API polling for ACTIVE state.
  FILE_POLL_INTERVAL_MS_DEFAULT: 3000,
  FILE_POLL_MAX_DEFAULT: 20,
  // Reconciler: pending_enqueue intent older than this is re-queued.
  ENQUEUE_STUCK_MS_DEFAULT: 60000,
  RECOVERY_BATCH_DEFAULT: 20,
  RECOVERY_BATCH_MIN: 1,
  RECOVERY_BATCH_MAX: 200,
  RETRY_DELAY_MS_DEFAULT: 5000,
  // Transcript reads.
  TRANSCRIPT_PAGE_DEFAULT: 100,
  TRANSCRIPT_PAGE_MAX: 200,
};

function isTerminalTranscriptionState(state) {
  return TERMINAL_TRANSCRIPTION_STATES.indexOf(state) !== -1;
}

function canTransitionTranscription(from, to) {
  const edges = TRANSCRIPTION_TRANSITIONS[from];
  return Array.isArray(edges) && edges.indexOf(to) !== -1;
}

function isRetryableTranscriptionError(code) {
  return RETRYABLE_TRANSCRIPTION_ERRORS.has(code);
}

function safeTranscriptionErrorCode(code) {
  if (typeof code === "string" && TRANSCRIPTION_ERROR_CODES.has(code)) {
    return code;
  }
  return "DB_ERROR";
}

module.exports = {
  TRANSCRIPTION_STATES,
  TERMINAL_TRANSCRIPTION_STATES,
  TRANSCRIPTION_TRANSITIONS,
  TRANSCRIPTION_VERSIONS,
  TRANSCRIPTION_ERROR_CODES,
  RETRYABLE_TRANSCRIPTION_ERRORS,
  TRANSCRIPTION_LIMITS,
  isTerminalTranscriptionState,
  canTransitionTranscription,
  isRetryableTranscriptionError,
  safeTranscriptionErrorCode,
};
