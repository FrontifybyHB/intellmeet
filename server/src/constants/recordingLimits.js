"use strict";

// Centralized Phase 3 recording/meeting-lifecycle contracts.
//
// Recording lifecycle (durable, provider-reconciled):
//   requested -> starting -> active -> stopping -> verifying -> ready
// Alternatives: failed (provider failure/limit), aborted (meeting end or
// a preserved quarantine raced capture), unknown (start timed out after the
// provider call — reconciliation required, NOT proof of absence).
// Terminal states (ready/failed/aborted) never regress: every
// transition is a conditional version-checked write, so stale or
// reordered provider callbacks cannot reopen a finished attempt.
//
// One nonterminal attempt per (meeting, session) is enforced by a
// partial unique index on the Recording model — simultaneous starts
// collapse to a single durable row via duplicate-key handling, the
// same pattern Phase 2 chat uses for message dedup.
const RECORDING_STATES = {
  REQUESTED: "requested",
  STARTING: "starting",
  ACTIVE: "active",
  STOPPING: "stopping",
  VERIFYING: "verifying",
  READY: "ready",
  FAILED: "failed",
  ABORTED: "aborted",
  UNKNOWN: "unknown",
};

const NONTERMINAL_STATES = [
  RECORDING_STATES.REQUESTED,
  RECORDING_STATES.STARTING,
  RECORDING_STATES.ACTIVE,
  RECORDING_STATES.STOPPING,
  RECORDING_STATES.VERIFYING,
  RECORDING_STATES.UNKNOWN,
];

const TERMINAL_STATES = [
  RECORDING_STATES.READY,
  RECORDING_STATES.FAILED,
  RECORDING_STATES.ABORTED,
];

// Legal conditional transitions. Absent edges are rejected — in
// particular no edge leaves a terminal state, and unknown resolves
// only through reconciliation (unknown -> starting on retry after
// reconcile, or unknown -> stopping when end/stop wins the race).
const RECORDING_TRANSITIONS = {
  requested: ["starting", "aborted", "unknown", "failed"],
  starting: ["active", "stopping", "verifying", "failed", "aborted", "unknown"],
  active: ["stopping", "verifying", "failed", "aborted"],
  stopping: ["verifying", "failed", "aborted"],
  verifying: ["ready", "failed", "aborted"],
  unknown: ["starting", "stopping", "verifying", "failed", "aborted"],
  ready: [],
  failed: [],
  aborted: [],
};

// Provider (LiveKit Egress) status normalization. Egress ended !=
// success: only a successful terminal status plus verified private
// output becomes ready. Limit/abort/failure outputs are never ready.
const PROVIDER_STATUS_MAP = {
  EGRESS_STARTING: "starting",
  EGRESS_ACTIVE: "active",
  EGRESS_ENDING: "stopping",
  EGRESS_COMPLETE: "verifying",
  EGRESS_FAILED: "failed",
  EGRESS_ABORTED: "aborted",
  EGRESS_LIMIT_REACHED: "failed",
};

const CONSENT_DECISIONS = {
  APPROVED: "approved",
  DECLINED: "declined",
};

// Recording consent is separate from any future AI-transfer permission.
// aiTransfer defaults to "undecided" and is NEVER inferred from the
// recording decision in either direction.
const TRANSFER_DECISIONS = {
  APPROVED: "approved",
  DECLINED: "declined",
  UNDECIDED: "undecided",
};

// Identities minted for the provider-side recorder. Matched by prefix
// against server-known values only — never by a client-supplied flag.
const RECORDER_IDENTITY_PREFIXES = ["EG-", "egress-", "recorder-"];

// Safe, whitelisted error codes persisted on recordings. Provider
// messages are never stored verbatim (they may carry paths/keys).
const RECORDING_ERROR_CODES = new Set([
  "PROVIDER_START_FAILED",
  "PROVIDER_STOP_FAILED",
  "PROVIDER_TIMEOUT_UNKNOWN",
  "PROVIDER_FAILED",
  "PROVIDER_LIMIT_REACHED",
  "PROVIDER_ABORTED",
  "CONSENT_WITHDRAWN",
  "CONSENT_MISSING",
  "MEETING_ENDED",
  "OUTPUT_MISSING",
  "STORAGE_VERIFY_FAILED",
  "OUTPUT_INVALID",
  "INTEGRATION_BLOCKER",
  "DB_ERROR",
]);

const RECORDING_LIMITS = {
  // Human-readable recording notice shown in the protected lab. Start
  // requires every admitted human to have approved THIS version.
  NOTICE_VERSION_DEFAULT: "v1",
  NOTICE_VERSION_MAX: 16,
  // Single configured output: one room-composite MP4 to private
  // Egress-compatible storage. No convenience second export.
  OUTPUT_FORMAT_DEFAULT: "mp4",
  STORAGE_KEY_PREFIX_DEFAULT: "recordings/",
  STORAGE_KEY_MAX: 512,
  // Provider RPC bounds: bounded deadline, no unlimited retries.
  PROVIDER_TIMEOUT_MS_DEFAULT: 8000,
  PROVIDER_TIMEOUT_MS_MIN: 1000,
  PROVIDER_TIMEOUT_MS_MAX: 60000,
  // Global active-Egress budget across replicas (each replica checks
  // the shared Recording collection; best-effort, fail closed).
  MAX_ACTIVE_GLOBAL_DEFAULT: 10,
  MAX_ACTIVE_GLOBAL_MIN: 1,
  MAX_ACTIVE_GLOBAL_MAX: 100,
  // Recovery: bounded batch, lease, attempts. A stuck attempt that
  // exhausts attempts is marked failed/unknown, never retried forever.
  RECOVERY_BATCH_DEFAULT: 20,
  RECOVERY_BATCH_MIN: 1,
  RECOVERY_BATCH_MAX: 200,
  RECOVERY_LEASE_MS_DEFAULT: 60000,
  RECOVERY_LEASE_MS_MIN: 10000,
  RECOVERY_LEASE_MS_MAX: 600000,
  RECOVERY_MAX_ATTEMPTS_DEFAULT: 5,
  RECOVERY_MAX_ATTEMPTS_MIN: 1,
  RECOVERY_MAX_ATTEMPTS_MAX: 25,
  // Stuck thresholds: attempts left in a transient state longer than
  // this become recovery candidates.
  STUCK_START_MS_DEFAULT: 90000,
  STUCK_STOP_MS_DEFAULT: 90000,
  // Short-lived access-link TTL (seconds).
  ACCESS_LINK_TTL_SECONDS_DEFAULT: 300,
  ACCESS_LINK_TTL_SECONDS_MIN: 60,
  ACCESS_LINK_TTL_SECONDS_MAX: 3600,
  // Webhook ingress bounds.
  WEBHOOK_MAX_BYTES_DEFAULT: 65536,
  WEBHOOK_MAX_BYTES_MIN: 4096,
  WEBHOOK_MAX_BYTES_MAX: 1048576,
};

module.exports = {
  RECORDING_STATES,
  NONTERMINAL_STATES,
  TERMINAL_STATES,
  RECORDING_TRANSITIONS,
  PROVIDER_STATUS_MAP,
  CONSENT_DECISIONS,
  TRANSFER_DECISIONS,
  RECORDER_IDENTITY_PREFIXES,
  RECORDING_ERROR_CODES,
  RECORDING_LIMITS,
};

function isTerminalState(state) {
  return TERMINAL_STATES.indexOf(state) !== -1;
}

function isNonterminalState(state) {
  return NONTERMINAL_STATES.indexOf(state) !== -1;
}

function canTransition(from, to) {
  const edges = RECORDING_TRANSITIONS[from];
  return Array.isArray(edges) && edges.indexOf(to) !== -1;
}

function mapProviderStatus(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toUpperCase().replace(/[ -]/g, "_");
  return PROVIDER_STATUS_MAP[normalized] || null;
}

function isRecorderIdentity(identity) {
  if (typeof identity !== "string" || identity.length === 0) {
    return false;
  }
  return RECORDER_IDENTITY_PREFIXES.some(
    (prefix) => identity.indexOf(prefix) === 0
  );
}

module.exports.isTerminalState = isTerminalState;
module.exports.isNonterminalState = isNonterminalState;
module.exports.canTransition = canTransition;
module.exports.mapProviderStatus = mapProviderStatus;
module.exports.isRecorderIdentity = isRecorderIdentity;
