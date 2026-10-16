"use strict";

// In-process, low-cardinality metrics for the Phase 2 socket/chat path.
// Aggregate counters only: no chat text, no credentials, no per-user or
// per-meeting labels. Persist latency uses fixed buckets so memory stays
// bounded regardless of message volume.
const PERSIST_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

// Rejection codes stay bounded by collapsing unknowns to "OTHER".
const KNOWN_REJECTIONS = new Set([
  "UNAUTHORIZED",
  "INVALID_MEETING_ID",
  "MEETING_NOT_FOUND",
  "NOT_A_MEMBER",
  "NOT_ADMITTED",
  "MEETING_ENDED",
  "MEETING_CANCELLED",
  "VALIDATION_ERROR",
  "INVALID_CURSOR",
  "INVALID_LIMIT",
  "INVALID_DIRECTION",
  "MESSAGE_CONFLICT",
  "RATE_LIMITED",
  "OVERLOADED",
  "TOO_MANY_ROOMS",
  "DB_ERROR",
  "INTERNAL_ERROR",
]);

const state = {
  socketsActive: 0,
  socketsTotal: 0,
  roomJoins: 0,
  sendsReceived: 0,
  sendsAccepted: 0,
  sendsDuplicate: 0,
  rejects: {},
  persistBuckets: PERSIST_BUCKETS_MS.map(() => 0),
  persistTotalMs: 0,
  persistSamples: 0,
  dbErrors: 0,
};

function normalizeRejection(code) {
  if (typeof code === "string" && KNOWN_REJECTIONS.has(code)) {
    return code;
  }
  return "OTHER";
}

function socketConnected() {
  state.socketsActive += 1;
  state.socketsTotal += 1;
}

function socketDisconnected() {
  if (state.socketsActive > 0) {
    state.socketsActive -= 1;
  }
}

function observeRoomJoin() {
  state.roomJoins += 1;
}

function observeSendReceived() {
  state.sendsReceived += 1;
}

function observeSendAccepted(persistMs, duplicate) {
  state.sendsAccepted += 1;
  if (duplicate) {
    state.sendsDuplicate += 1;
  }
  const duration =
    typeof persistMs === "number" && Number.isFinite(persistMs) && persistMs >= 0
      ? persistMs
      : 0;
  state.persistTotalMs += duration;
  state.persistSamples += 1;
  for (let i = 0; i < PERSIST_BUCKETS_MS.length; i += 1) {
    if (duration <= PERSIST_BUCKETS_MS[i]) {
      state.persistBuckets[i] += 1;
      return;
    }
  }
  state.persistBuckets[PERSIST_BUCKETS_MS.length - 1] += 1;
}

function observeReject(code) {
  const outcome = normalizeRejection(code || "OTHER");
  state.rejects[outcome] = (state.rejects[outcome] || 0) + 1;
}

function observeDbError() {
  state.dbErrors += 1;
}

function approxPercentile(fraction) {
  if (state.persistSamples === 0) {
    return 0;
  }
  const rank = fraction * state.persistSamples;
  let cumulative = 0;
  for (let i = 0; i < state.persistBuckets.length; i += 1) {
    cumulative += state.persistBuckets[i];
    if (cumulative >= rank) {
      return PERSIST_BUCKETS_MS[i];
    }
  }
  return PERSIST_BUCKETS_MS[PERSIST_BUCKETS_MS.length - 1];
}

function getSnapshot() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    socketsActive: state.socketsActive,
    socketsTotal: state.socketsTotal,
    roomJoins: state.roomJoins,
    sendsReceived: state.sendsReceived,
    sendsAccepted: state.sendsAccepted,
    sendsDuplicate: state.sendsDuplicate,
    rejects: { ...state.rejects },
    persistAvgMs:
      state.persistSamples === 0 ? 0 : state.persistTotalMs / state.persistSamples,
    persistP50Ms: approxPercentile(0.5),
    persistP95Ms: approxPercentile(0.95),
    persistP99Ms: approxPercentile(0.99),
    dbErrors: state.dbErrors,
    rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
    heapUsedMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
  };
}

function reset() {
  state.socketsActive = 0;
  state.socketsTotal = 0;
  state.roomJoins = 0;
  state.sendsReceived = 0;
  state.sendsAccepted = 0;
  state.sendsDuplicate = 0;
  state.rejects = {};
  state.persistBuckets = PERSIST_BUCKETS_MS.map(() => 0);
  state.persistTotalMs = 0;
  state.persistSamples = 0;
  state.dbErrors = 0;
}

module.exports = {
  socketConnected,
  socketDisconnected,
  observeRoomJoin,
  observeSendReceived,
  observeSendAccepted,
  observeReject,
  observeDbError,
  getSnapshot,
  reset,
};
