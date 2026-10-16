"use strict";

// In-process, low-cardinality metrics for POST /api/meetings/:id/join.
// Aggregate counters only: no per-user / per-meeting labels, no tokens,
// no credentials, no meeting contents. Durations use fixed buckets so
// memory stays bounded regardless of request volume.
const DURATION_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

// Known outcome codes stay as-is; anything else collapses to "OTHER" so
// the error map cannot grow without bound on unexpected inputs.
const KNOWN_CODES = new Set([
  "OK",
  "UNAUTHORIZED",
  "INVALID_MEETING_ID",
  "MEETING_NOT_FOUND",
  "NOT_A_MEMBER",
  "NOT_ADMITTED",
  "MEETING_ENDED",
  "MEETING_CANCELLED",
  "LIVEKIT_MISCONFIGURED",
  "TOKEN_SIGNING_FAILED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

const state = {
  joins: 0,
  ok: 0,
  rateLimited: 0,
  errors: {},
  buckets: DURATION_BUCKETS_MS.map(() => 0),
  totalDurationMs: 0,
};

function normalizeCode(code) {
  if (typeof code === "string" && KNOWN_CODES.has(code)) {
    return code;
  }
  return "OTHER";
}

function observeJoin(durationMs, code) {
  const outcome = normalizeCode(code || "OTHER");
  const duration =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? durationMs
      : 0;
  state.joins += 1;
  state.totalDurationMs += duration;
  if (outcome === "OK") {
    state.ok += 1;
  } else {
    state.errors[outcome] = (state.errors[outcome] || 0) + 1;
  }
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i += 1) {
    if (duration <= DURATION_BUCKETS_MS[i]) {
      state.buckets[i] += 1;
      return;
    }
  }
  state.buckets[DURATION_BUCKETS_MS.length - 1] += 1;
}

function observeRateLimited() {
  state.rateLimited += 1;
}

// Approximate percentile from fixed buckets (upper-bound estimate).
function approxPercentile(fraction) {
  if (state.joins === 0) {
    return 0;
  }
  const rank = fraction * state.joins;
  let cumulative = 0;
  for (let i = 0; i < state.buckets.length; i += 1) {
    cumulative += state.buckets[i];
    if (cumulative >= rank) {
      return DURATION_BUCKETS_MS[i];
    }
  }
  return DURATION_BUCKETS_MS[DURATION_BUCKETS_MS.length - 1];
}

function getSnapshot() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    joins: state.joins,
    ok: state.ok,
    rateLimited: state.rateLimited,
    errors: { ...state.errors },
    buckets: [...state.buckets],
    bucketBoundsMs: [...DURATION_BUCKETS_MS],
    avgMs: state.joins === 0 ? 0 : state.totalDurationMs / state.joins,
    approxP50Ms: approxPercentile(0.5),
    approxP95Ms: approxPercentile(0.95),
    approxP99Ms: approxPercentile(0.99),
    rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
    heapUsedMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
  };
}

function reset() {
  state.joins = 0;
  state.ok = 0;
  state.rateLimited = 0;
  state.errors = {};
  state.buckets = DURATION_BUCKETS_MS.map(() => 0);
  state.totalDurationMs = 0;
}

module.exports = { observeJoin, observeRateLimited, getSnapshot, reset };
module.exports.DURATION_BUCKETS_MS = DURATION_BUCKETS_MS;
