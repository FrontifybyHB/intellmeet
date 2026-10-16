"use strict";

// BullMQ queue client for Phase 5 intelligence jobs. Lazy singleton:
// importing this module never connects — connections open on first
// use, so the HTTP/socket server process stays worker-free.
//
// - Queue payload carries identifiers/run version ONLY (no transcript
//   bodies, outputs, secrets, consent rows, or credentials). The worker
//   re-reads trusted Mongo state.
// - Deterministic jobId `ix:<intelligenceId>:<runVersion>` dedupes
//   replays; the durable unique run/suggestion constraints stay
//   authoritative after jobs are removed.
// - Attempts + exponential backoff + jitter bound worker retries;
//   removeOnComplete/removeOnFail bound Redis growth.
// - Cluster-wide daily provider-call budget via Redis INCR+EXPIRE,
//   counted across every map/reduce/retry call. This counter is sized
//   JOINTLY with the Phase 4 transcript budget against the project's
//   shared Gemini quota — the two budgets do not grant independent
//   quota.
// Docs: https://docs.bullmq.io/patterns/idempotent-jobs (v6
// installed; connection requires maxRetriesPerRequest: null).

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const { INTELLIGENCE_LIMITS } = require("../constants/intelligenceLimits");

let queueInstance = null;
let connectionInstance = null;

function requireRedisUrl() {
  const env = getEnv();
  if (!env.redisUrl) {
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Intelligence queue is not configured.",
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
  queueInstance = new Queue(INTELLIGENCE_LIMITS.QUEUE_NAME, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: env.intelJobAttempts,
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

function jobIdFor({ intelligenceId, runVersion }) {
  return `ix:${String(intelligenceId)}:${Number(runVersion)}`;
}

async function addIntelligenceJob({ intelligenceId, runId, runVersion }) {
  const queue = getQueue();
  const env = getEnv();
  const jitter = Math.floor(Math.random() * 1000);
  return queue.add(
    "summarize",
    {
      intelligenceId: String(intelligenceId),
      runId,
      runVersion: Number(runVersion),
    },
    {
      jobId: jobIdFor({ intelligenceId, runVersion }),
      attempts: env.intelJobAttempts,
      backoff: { type: "exponential", delay: 2000 + jitter },
    }
  );
}

async function getWaitingCount() {
  try {
    const queue = getQueue();
    return await queue.getWaitingCount();
  } catch (_unused) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function dayKey(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return `intellmeet:ix:calls:${date.toISOString().slice(0, 10)}`;
}

// Cluster-wide daily provider-call slot: shared project budget first
// (see queues/geminiBudget.js — Phase 4 and Phase 5 caps do not grant
// independent quota), then the per-pipeline cap. Throws
// PROVIDER_QUOTA_EXHAUSTED when either budget is spent (terminal for
// the run — a new day or raised budget needs a new run).
async function takeProviderCallSlot() {
  const env = getEnv();
  const connection = getConnection();
  await require("./geminiBudget").takeSharedCallSlot(connection);
  const key = dayKey(Date.now());
  const count = await connection.incr(key);
  if (count === 1) {
    await connection.expire(key, 86400 + 3600);
  }
  if (count > env.intelMaxCallsPerDay) {
    const err = new Error("Daily intelligence budget exhausted.");
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
  addIntelligenceJob,
  getWaitingCount,
  takeProviderCallSlot,
  jobIdFor,
  closeForTests,
};
