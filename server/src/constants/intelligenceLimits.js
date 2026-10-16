"use strict";

// Centralized Phase 5 meeting-intelligence contracts.
//
// Eligibility (all required, fail closed):
// - meeting status === "ended" (post-meeting only);
// - recording state === "ready", consentRevoked !== true;
// - transcription published a COMPLETE run (publishedRunVersion set);
//   only segments of that pinned run are input — partial, cancelled,
//   or superseded sources never masquerade as complete;
// - explicit Google transfer consent (aiTransfer === "approved") at the
//   CURRENT notice version for every captured human, re-checked at
//   schedule time, immediately before each external call, and before
//   publication (reuse of the Phase 4 gate — recording-only approval
//   is insufficient).
//
// Run identity: recordingId + immutable source (transcript runId +
// runVersion + segment count) + PIPELINE/MODEL/PROMPT/SCHEMA/CONTEXT
// versions. A source/model/prompt change yields a NEW run; staged and
// published outputs of different runs never mix.
//
// Run states: pending_enqueue -> queued -> running -> complete, with
// retrying (worker-owned transient), blocked (eligibility), failed,
// cancelled (terminal). Conditional version-checked writes on
// (runId, version) fence; terminal runs are superseded only by a NEW
// runId+runVersion, never resurrected in place.
//
// In-flight external race (documented, not hidden): once transcript
// text leaves for Google, local cancellation cannot unsend it. Cancel
// suppresses publication of late results — it never claims remote
// processing/retention instantly ceased (text calls have no remote
// file to delete; the boundary is reported, not hidden).
//
// Task boundary: one Task per approved suggestion, idempotent on the
// suggestion's stable taskIdempotencyKey. Non-approved items report
// 409 TASK_NOT_APPROVED; duplicate POSTs and timeout replays resume
// the same Task instead of forking.
const INTELLIGENCE_STATES = {
  PENDING_ENQUEUE: "pending_enqueue",
  QUEUED: "queued",
  RUNNING: "running",
  RETRYING: "retrying",
  COMPLETE: "complete",
  FAILED: "failed",
  CANCELLED: "cancelled",
  BLOCKED: "blocked",
};

const TERMINAL_INTELLIGENCE_STATES = [
  INTELLIGENCE_STATES.COMPLETE,
  INTELLIGENCE_STATES.FAILED,
  INTELLIGENCE_STATES.CANCELLED,
  INTELLIGENCE_STATES.BLOCKED,
];

// Legal conditional transitions. Absent edges are rejected. Terminal
// outgoing edges exist ONLY to supersede with a NEW runId+runVersion
// (the fence binds the old runId, so stale workers cannot write).
const INTELLIGENCE_TRANSITIONS = {
  pending_enqueue: ["queued", "blocked", "cancelled", "failed"],
  queued: ["running", "cancelled", "blocked", "failed"],
  running: ["retrying", "complete", "failed", "cancelled", "blocked"],
  retrying: ["running", "complete", "failed", "cancelled", "blocked"],
  complete: ["pending_enqueue", "blocked"],
  failed: ["pending_enqueue", "blocked"],
  cancelled: ["pending_enqueue", "blocked"],
  blocked: ["pending_enqueue", "blocked"],
};

// Pipeline identity versions, persisted on every run. Bump prompt on
// instruction changes, schema on output-contract changes, context on
// windowing/context-assembly changes, pipeline on orchestration
// changes. A run only publishes output produced under its own versions.
const INTELLIGENCE_VERSIONS = {
  PIPELINE: "i1",
  PROMPT: "p1",
  SCHEMA: "s2",
  CONTEXT: "c1",
};

// Safe, whitelisted terminal failure/block codes persisted on runs.
// Provider messages are never stored verbatim.
const INTELLIGENCE_ERROR_CODES = new Set([
  "CONSENT_BLOCKED",
  "CONSENT_WITHDRAWN",
  "TRANSFER_CONSENT_MISSING",
  "RECORDING_NOT_READY",
  "OUTPUT_MISSING",
  "OUTPUT_INVALID",
  "MEETING_NOT_ENDED",
  "MEETING_NOT_FOUND",
  "NOT_HOST",
  "TRANSCRIPT_NOT_READY",
  "TRANSCRIPT_SUPERSEDED",
  "SOURCE_TOO_LARGE",
  "INTEGRATION_BLOCKER",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_FAILED",
  "OUTPUT_TRUNCATED",
  "OUTPUT_MALFORMED",
  "OUTPUT_SAFETY_BLOCKED",
  "OUTPUT_INCOMPLETE",
  "EVIDENCE_INVALID",
  "SCHEMA_INVALID",
  "RUN_SUPERSEDED",
  "TASK_CONTRACT_ABSENT",
  "TASK_NOT_APPROVED",
  "OWNER_INELIGIBLE",
  "VERSION_CONFLICT",
  "VALIDATION_ERROR",
  "CANCELLED",
  "DB_ERROR",
]);

// Errors safe to retry inside the bounded attempt budget.
const RETRYABLE_INTELLIGENCE_ERRORS = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "DB_ERROR",
]);

// Review states for suggested actions. Approval records the reviewer
// decision; POST .../task materializes exactly one Task per approved
// suggestion (idempotent on taskIdempotencyKey).
const ACTION_ITEM_STATES = {
  PROPOSED: "proposed",
  APPROVED: "approved",
  REJECTED: "rejected",
};

const INTELLIGENCE_LIMITS = {
  QUEUE_NAME: "intellmeet-intelligence",
  WORKER_CONCURRENCY_DEFAULT: 2,
  WORKER_CONCURRENCY_MIN: 1,
  WORKER_CONCURRENCY_MAX: 16,
  QUEUE_MAX_WAITING_DEFAULT: 200,
  QUEUE_MAX_WAITING_MIN: 1,
  QUEUE_MAX_WAITING_MAX: 10000,
  JOB_ATTEMPTS_DEFAULT: 5,
  JOB_ATTEMPTS_MIN: 1,
  JOB_ATTEMPTS_MAX: 10,
  STEP_TIMEOUT_MS_DEFAULT: 120000,
  STEP_TIMEOUT_MS_MIN: 15000,
  STEP_TIMEOUT_MS_MAX: 600000,
  RUN_TIMEOUT_MS_DEFAULT: 1800000,
  RUN_TIMEOUT_MS_MIN: 120000,
  RUN_TIMEOUT_MS_MAX: 7200000,
  // Cluster-wide provider call budget per day for intelligence calls
  // (map + reduce + retries). Sized jointly with the Phase 4
  // TRANSCRIPT_MAX_CALLS_PER_DAY against the project's shared Gemini
  // quota — the two counters do not grant independent quota.
  MAX_CALLS_PER_DAY_DEFAULT: 200,
  MAX_CALLS_PER_DAY_MIN: 1,
  MAX_CALLS_PER_DAY_MAX: 100000,
  // Source windowing: ordered segment windows with original IDs.
  // Single pass when the pinned transcript fits; otherwise bounded
  // map windows + one reconcile call. Windows are never silently
  // dropped: uncovered input reports blocked/incomplete.
  WINDOW_CHARS_DEFAULT: 12000,
  WINDOW_CHARS_MIN: 2000,
  WINDOW_CHARS_MAX: 60000,
  MAX_WINDOWS_DEFAULT: 8,
  MAX_WINDOWS_MIN: 1,
  MAX_WINDOWS_MAX: 16,
  MAX_SOURCE_BYTES_DEFAULT: 200000,
  MAX_SOURCE_BYTES_MIN: 10000,
  MAX_SOURCE_BYTES_MAX: 1000000,
  MAX_OUTPUT_BYTES_DEFAULT: 60000,
  // Output cardinality bounds.
  SUMMARY_BULLETS_MAX_DEFAULT: 12,
  DECISIONS_MAX_DEFAULT: 20,
  BLOCKERS_MAX_DEFAULT: 20,
  QUESTIONS_MAX_DEFAULT: 20,
  ACTIONS_MAX_DEFAULT: 20,
  EVIDENCE_PER_ITEM_MAX_DEFAULT: 6,
  // String bounds.
  BULLET_CHARS_MAX: 500,
  DECISION_CHARS_MAX: 500,
  BLOCKER_CHARS_MAX: 500,
  QUESTION_CHARS_MAX: 500,
  ACTION_TITLE_MAX: 200,
  ACTION_DETAIL_MAX: 1000,
  OWNER_TEXT_MAX: 120,
  DUEDATE_TEXT_MAX: 120,
  // Reads.
  ACTION_PAGE_DEFAULT: 50,
  ACTION_PAGE_MAX: 100,
  ENQUEUE_STUCK_MS_DEFAULT: 60000,
  RECOVERY_BATCH_DEFAULT: 20,
};

function isTerminalIntelligenceState(state) {
  return TERMINAL_INTELLIGENCE_STATES.indexOf(state) !== -1;
}

function canTransitionIntelligence(from, to) {
  const edges = INTELLIGENCE_TRANSITIONS[from];
  return Array.isArray(edges) && edges.indexOf(to) !== -1;
}

function isRetryableIntelligenceError(code) {
  return RETRYABLE_INTELLIGENCE_ERRORS.has(code);
}

function safeIntelligenceErrorCode(code) {
  if (typeof code === "string" && INTELLIGENCE_ERROR_CODES.has(code)) {
    return code;
  }
  return "DB_ERROR";
}

module.exports = {
  INTELLIGENCE_STATES,
  TERMINAL_INTELLIGENCE_STATES,
  INTELLIGENCE_TRANSITIONS,
  INTELLIGENCE_VERSIONS,
  INTELLIGENCE_ERROR_CODES,
  RETRYABLE_INTELLIGENCE_ERRORS,
  ACTION_ITEM_STATES,
  INTELLIGENCE_LIMITS,
  isTerminalIntelligenceState,
  canTransitionIntelligence,
  isRetryableIntelligenceError,
  safeIntelligenceErrorCode,
};
