"use strict";

// In-process, low-cardinality metrics for the Phase 3 recording path.
// Same discipline as Phase 2 chat/join metrics: aggregate counters
// only — no secrets, signed URLs, raw webhooks, media, consent detail,
// or high-cardinality labels (rejection codes collapse to KNOWN set).
const KNOWN_REJECTIONS = new Set([
  "UNAUTHORIZED",
  "INVALID_MEETING_ID",
  "INVALID_RECORDING_ID",
  "MEETING_NOT_FOUND",
  "NOT_A_MEMBER",
  "NOT_ADMITTED",
  "NOT_HOST",
  "MEETING_ENDED",
  "MEETING_CANCELLED",
  "CONSENT_BLOCKED",
  "CONSENT_MISSING",
  "NOTICE_VERSION_MISMATCH",
  "VALIDATION_ERROR",
  "RECORDING_ACTIVE",
  "RECORDING_NOT_FOUND",
  "RECORDING_CONFLICT",
  "INTEGRATION_BLOCKER",
  "RATE_LIMITED",
  "OVERLOADED",
  "WEBHOOK_REJECTED",
  "DB_ERROR",
  "INTERNAL_ERROR",
]);

const PROVIDER_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 8000];

const state = {
  starts: 0,
  stops: 0,
  ends: 0,
  errors: 0,
  webhookRejects: 0,
  webhookApplied: 0,
  reconciliations: 0,
  recoveryClaimed: 0,
  rejects: {},
  providerBuckets: PROVIDER_BUCKETS_MS.map(() => 0),
  providerTotalMs: 0,
  providerSamples: 0,
};

function normalizeRejection(code) {
  if (typeof code === "string" && KNOWN_REJECTIONS.has(code)) {
    return code;
  }
  return "OTHER";
}

function observeReject(code) {
  const key = normalizeRejection(code);
  state.rejects[key] = (state.rejects[key] || 0) + 1;
}

function observeStart() {
  state.starts += 1;
}

function observeStop() {
  state.stops += 1;
}

function observeEnd() {
  state.ends += 1;
}

function observeError() {
  state.errors += 1;
}

function observeWebhookReject() {
  state.webhookRejects += 1;
}

function observeWebhookApplied() {
  state.webhookApplied += 1;
}

function observeReconciliation() {
  state.reconciliations += 1;
}

function observeRecoveryClaimed(count) {
  state.recoveryClaimed += count;
}

function observeProviderLatency(ms) {
  state.providerTotalMs += ms;
  state.providerSamples += 1;
  for (let i = 0; i < PROVIDER_BUCKETS_MS.length; i += 1) {
    if (ms <= PROVIDER_BUCKETS_MS[i]) {
      state.providerBuckets[i] += 1;
      return;
    }
  }
}

function snapshot() {
  return {
    starts: state.starts,
    stops: state.stops,
    ends: state.ends,
    errors: state.errors,
    webhookRejects: state.webhookRejects,
    webhookApplied: state.webhookApplied,
    reconciliations: state.reconciliations,
    recoveryClaimed: state.recoveryClaimed,
    rejects: { ...state.rejects },
    providerBuckets: state.providerBuckets.slice(),
    providerSamples: state.providerSamples,
    providerAvgMs:
      state.providerSamples === 0
        ? null
        : state.providerTotalMs / state.providerSamples,
  };
}

function resetForTests() {
  state.starts = 0;
  state.stops = 0;
  state.ends = 0;
  state.errors = 0;
  state.webhookRejects = 0;
  state.webhookApplied = 0;
  state.reconciliations = 0;
  state.recoveryClaimed = 0;
  state.rejects = {};
  state.providerBuckets = PROVIDER_BUCKETS_MS.map(() => 0);
  state.providerTotalMs = 0;
  state.providerSamples = 0;
}

module.exports = {
  observeReject,
  observeStart,
  observeStop,
  observeEnd,
  observeError,
  observeWebhookReject,
  observeWebhookApplied,
  observeReconciliation,
  observeRecoveryClaimed,
  observeProviderLatency,
  snapshot,
  resetForTests,
};
