"use strict";

// In-process, low-cardinality metrics for the Phase 5 intelligence
// path. Aggregate counters only — no transcript text, prompts, model
// outputs, keys, consent detail, or per-user/meeting labels. Queue
// depth/age is read live from BullMQ, never cached here.
const KNOWN_FAILURES = new Set([
  "CONSENT_BLOCKED",
  "CONSENT_WITHDRAWN",
  "TRANSFER_CONSENT_MISSING",
  "RECORDING_NOT_READY",
  "OUTPUT_MISSING",
  "MEETING_NOT_ENDED",
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
  "CANCELLED",
  "DB_ERROR",
]);

const state = {
  enqueued: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  blocked: 0,
  retries: 0,
  windows: 0,
  providerCalls: 0,
  approvals: 0,
  approvalConflicts: 0,
  failures: {},
};

function normalize(code) {
  if (typeof code === "string" && KNOWN_FAILURES.has(code)) {
    return code;
  }
  return "OTHER";
}

function observeEnqueue() {
  state.enqueued += 1;
}

function observeComplete() {
  state.completed += 1;
}

function observeFailed(code) {
  state.failed += 1;
  const key = normalize(code);
  state.failures[key] = (state.failures[key] || 0) + 1;
}

function observeCancelled() {
  state.cancelled += 1;
}

function observeBlocked(code) {
  state.blocked += 1;
  const key = normalize(code);
  state.failures[key] = (state.failures[key] || 0) + 1;
}

function observeRetry() {
  state.retries += 1;
}

function observeWindow() {
  state.windows += 1;
}

function observeProviderCall() {
  state.providerCalls += 1;
}

function observeApproval() {
  state.approvals += 1;
}

function observeApprovalConflict() {
  state.approvalConflicts += 1;
}

function snapshot() {
  return {
    enqueued: state.enqueued,
    completed: state.completed,
    failed: state.failed,
    cancelled: state.cancelled,
    blocked: state.blocked,
    retries: state.retries,
    windows: state.windows,
    providerCalls: state.providerCalls,
    approvals: state.approvals,
    approvalConflicts: state.approvalConflicts,
    failures: { ...state.failures },
  };
}

function resetForTests() {
  state.enqueued = 0;
  state.completed = 0;
  state.failed = 0;
  state.cancelled = 0;
  state.blocked = 0;
  state.retries = 0;
  state.windows = 0;
  state.providerCalls = 0;
  state.approvals = 0;
  state.approvalConflicts = 0;
  state.failures = {};
}

module.exports = {
  observeEnqueue,
  observeComplete,
  observeFailed,
  observeCancelled,
  observeBlocked,
  observeRetry,
  observeWindow,
  observeProviderCall,
  observeApproval,
  observeApprovalConflict,
  snapshot,
  resetForTests,
};
