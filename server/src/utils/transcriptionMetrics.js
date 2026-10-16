"use strict";

// In-process, low-cardinality metrics for the Phase 4 transcription
// path. Aggregate counters only — no audio, transcript text, prompts,
// provider response bodies, keys, file URIs, or consent detail. Queue
// depth/age is read live from BullMQ, never cached here.
const KNOWN_FAILURES = new Set([
  "CONSENT_BLOCKED",
  "TRANSFER_CONSENT_MISSING",
  "RECORDING_NOT_READY",
  "OUTPUT_MISSING",
  "OUTPUT_INVALID",
  "MEETING_NOT_ENDED",
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

const PROVIDER_BUCKETS_MS = [500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];

const state = {
  enqueued: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  blocked: 0,
  retries: 0,
  chunks: 0,
  providerCalls: 0,
  provider429: 0,
  failures: {},
  providerBuckets: PROVIDER_BUCKETS_MS.map(() => 0),
  providerTotalMs: 0,
  providerSamples: 0,
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

function observeChunk() {
  state.chunks += 1;
}

function observeProviderCall() {
  state.providerCalls += 1;
}

function observeProvider429() {
  state.provider429 += 1;
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
    enqueued: state.enqueued,
    completed: state.completed,
    failed: state.failed,
    cancelled: state.cancelled,
    blocked: state.blocked,
    retries: state.retries,
    chunks: state.chunks,
    providerCalls: state.providerCalls,
    provider429: state.provider429,
    failures: { ...state.failures },
    providerBuckets: state.providerBuckets.slice(),
    providerSamples: state.providerSamples,
    providerAvgMs:
      state.providerSamples === 0 ? null : state.providerTotalMs / state.providerSamples,
  };
}

function resetForTests() {
  state.enqueued = 0;
  state.completed = 0;
  state.failed = 0;
  state.cancelled = 0;
  state.blocked = 0;
  state.retries = 0;
  state.chunks = 0;
  state.providerCalls = 0;
  state.provider429 = 0;
  state.failures = {};
  state.providerBuckets = PROVIDER_BUCKETS_MS.map(() => 0);
  state.providerTotalMs = 0;
  state.providerSamples = 0;
}

module.exports = {
  observeEnqueue,
  observeComplete,
  observeFailed,
  observeCancelled,
  observeBlocked,
  observeRetry,
  observeChunk,
  observeProviderCall,
  observeProvider429,
  observeProviderLatency,
  snapshot,
  resetForTests,
};
