"use strict";

// BullMQ queue client for Phase 4 transcription jobs. Lazy singleton:
// importing this module never connects — connections open on first
// use, so the HTTP/socket server process stays worker-free.
//
// - Queue payload carries identifiers/run version ONLY (no audio,
//   transcripts, secrets, consent rows, or signed URLs). The worker
//   re-reads trusted Mongo state.
// - Deterministic jobId `tr:<recordingId>:<runVersion>` (BullMQ jobId
//   rules: non-empty string) dedupes replays; the durable unique
//   run/segment constraints stay authoritative after jobs are removed.
// - Attempts + exponential backoff + jitter bound worker retries;
//   removeOnComplete/removeOnFail bound Redis growth.
// - Cluster-wide daily provider-call budget via Redis INCR+EXPIRE
//   (a jobs/sec limiter alone cannot enforce token/day spend).
// Docs: https://docs.bullmq.io/ (v6 installed; connection requires
// maxRetriesPerRequest: null).

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const { TRANSCRIPTION_LIMITS } = require("../constants/transcriptionLimits");

let queueInstance = null;
let connectionInstance = null;

function requireRedisUrl() {
  const env = getEnv();
  if (!env.redisUrl) {
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Transcription queue is not configured.",
      "INTEGRATION_BLOCKER"
    );
  }
  return env.redisUrl;
}

function getConnection() {
  if (connectionInstance) {
    return connectionInstance;
  }
  const url = requireRedisUrl();
  const IORedis = require("ioredis");
  connectionInstance = new IORedis(url, {
    // Required by BullMQ: the client must not fail timed-out
    // blocking commands used for job delivery.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  connectionInstance.on("error", () => {
    // Swallowed: queue operations surface errors to callers; the
    // process must not crash on Redis blips (backpressure instead).
  });
  return connectionInstance;
}

function getQueue() {
  if (queueInstance) {
    return queueInstance;
  }
  const { Queue } = require("bullmq");
  const env = getEnv();
  queueInstance = new Queue(TRANSCRIPTION_LIMITS.QUEUE_NAME, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: env.transcriptJobAttempts,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  });
  return queueInstance;
}

function jobIdFor({ recordingId, runVersion }) {
  return `tr:${String(recordingId)}:${Number(runVersion)}`;
}

async function addTranscriptionJob({ recordingId, runId, runVersion }) {
  const queue = getQueue();
  const env = getEnv();
  const jitter = Math.floor(Math.random() * 1000);
  return queue.add(
    "transcribe",
    { recordingId: String(recordingId), runId, runVersion: Number(runVersion) },
    {
      jobId: jobIdFor({ recordingId, runVersion }),
      attempts: env.transcriptJobAttempts,
      backoff: { type: "exponential", delay: 2000 + jitter },
    }
  );
}

async function getWaitingCount() {
  try {
    const queue = getQueue();
    return await queue.getWaitingCount();
  } catch (_unused) {
    // Queue unreachable: treat as full (backpressure) rather than
    // admitting unbounded work that cannot be scheduled.
    return Number.MAX_SAFE_INTEGER;
  }
}

function dayKey(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return `intellmeet:tx:calls:${date.toISOString().slice(0, 10)}`;
}

// Cluster-wide daily provider-call slot: shared project budget first
// (see queues/geminiBudget.js — Phase 4 and Phase 5 caps do not grant
// independent quota), then the per-pipeline cap. Throws
// PROVIDER_QUOTA_EXHAUSTED when either budget is spent (terminal for
// the run — a new day or a raised budget needs a new run, never
// silent over-spend).
async function takeProviderCallSlot() {
  const env = getEnv();
  const connection = getConnection();
  await require("./geminiBudget").takeSharedCallSlot(connection);
  const key = dayKey(Date.now());
  const count = await connection.incr(key);
  if (count === 1) {
    await connection.expire(key, 86400 + 3600);
  }
  if (count > env.transcriptMaxCallsPerDay) {
    const err = new Error("Daily transcription budget exhausted.");
    err.code = "PROVIDER_QUOTA_EXHAUSTED";
    throw err;
  }
  return count;
}

async function closeForTests() {
  if (queueInstance) {
    try {
      await queueInstance.close();
    } catch (_unused) {
      // Close failures must not fail tests.
    }
    queueInstance = null;
  }
  if (connectionInstance) {
    try {
      await connectionInstance.quit();
    } catch (_unused) {
      try {
        await connectionInstance.disconnect();
      } catch (_ignored) {
        // Ignore.
      }
    }
    connectionInstance = null;
  }
}

module.exports = {
  getQueue,
  getConnection,
  addTranscriptionJob,
  getWaitingCount,
  takeProviderCallSlot,
  jobIdFor,
  closeForTests,
};
