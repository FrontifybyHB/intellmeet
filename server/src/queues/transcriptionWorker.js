"use strict";

// Separate transcription worker entrypoint. Importing this module
// never starts consumption — call startTranscriptionWorker() or run
// `node src/queues/transcriptionWorker.js`. The HTTP/socket server
// process never imports this file.
//
// Usage:
//   REDIS_URL=redis://127.0.0.1:6379 \
//   MONGODB_URI=mongodb://127.0.0.1:27017/intellmeet \
//   TRANSCRIPTION_PROVIDER=mock \
//   node src/queues/transcriptionWorker.js
//
// Cluster-wide limits (concurrency per worker + shared daily call
// budget in transcriptionQueue) apply across replicas; local
// concurrency alone is not the budget.

const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const { TRANSCRIPTION_LIMITS } = require("../constants/transcriptionLimits");
const { processTranscriptionJob, workerIdentity } = require("../services/transcriptionRunner");

let activeWorker = null;
let ownedConnection = null;
let recoveryScheduler = null;

// Bounded durable-recovery loop for this worker's lifecycle (see
// queues/recoveryScheduler.js for placement/bounds). Covers the
// Mongo commit -> queue-add gap, missing intents, and stranded runs.
async function startRecoveryScheduler({ intervalMs, jitterMs } = {}) {
  if (recoveryScheduler) {
    return recoveryScheduler;
  }
  const { startRecoveryScheduler: start } = require("./recoveryScheduler");
  const {
    reconcilePendingEnqueues,
    reconcileMissingIntents,
    reconcileStrandedRuns,
  } = require("../services/transcriptionRecovery");
  recoveryScheduler = start({
    name: "transcription",
    intervalMs,
    jitterMs,
    recover: async () => {
      await reconcilePendingEnqueues({});
      await reconcileMissingIntents({});
      await reconcileStrandedRuns({});
    },
  });
  return recoveryScheduler;
}

function stopRecoveryScheduler() {
  if (recoveryScheduler) {
    try {
      recoveryScheduler.stop();
    } finally {
      recoveryScheduler = null;
    }
  }
}

async function startTranscriptionWorker({ connection } = {}) {
  if (activeWorker) {
    return activeWorker;
  }
  const { Worker } = require("bullmq");
  const env = getEnv();
  const workerId = workerIdentity();
  let conn = connection;
  if (!conn) {
    if (!env.redisUrl) {
      throw new Error("REDIS_URL is required to start the transcription worker.");
    }
    const IORedis = require("ioredis");
    conn = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    ownedConnection = conn;
  }
  activeWorker = new Worker(
    TRANSCRIPTION_LIMITS.QUEUE_NAME,
    async (job) => processTranscriptionJob(job, { workerId }),
    {
      connection: conn,
      concurrency: env.transcriptWorkerConcurrency,
      // Stall protection: a crashed owner redelivers; the run claim
      // fence + chunk checkpoints make redelivery converge without
      // double-publish.
      lockDuration: 60000,
      stalledInterval: 30000,
      maxStalledCount: 3,
    }
  );
  activeWorker.on("completed", (job) => {
    logger.info("transcription_job_completed", { jobId: job && job.id });
  });
  activeWorker.on("failed", (job, err) => {
    // Only safe codes are logged; never payloads or transcripts.
    logger.error("transcription_job_failed", {
      jobId: job && job.id,
      code: err && err.code ? String(err.code) : "UNKNOWN",
    });
  });
  activeWorker.on("error", (err) => {
    logger.error("transcription_worker_error", {
      code: err && err.code ? String(err.code) : "UNKNOWN",
    });
  });
  logger.info("transcription_worker_started", {
    concurrency: env.transcriptWorkerConcurrency,
  });
  return activeWorker;
}

async function stopTranscriptionWorker() {
  if (activeWorker) {
    try {
      await activeWorker.close();
    } finally {
      activeWorker = null;
    }
  }
  if (ownedConnection) {
    try {
      await ownedConnection.quit();
    } catch (_unused) {
      try {
        ownedConnection.disconnect();
      } catch (_ignored) {
        // Ignore.
      }
    } finally {
      ownedConnection = null;
    }
  }
  logger.info("transcription_worker_stopped", {});
}

async function runAsMain() {
  const connectDB = require("../config/db");
  await connectDB();
  // Crash-recovery janitor: remove temp dirs from runs that never
  // reached their finally cleanup (bounded count, age-gated).
  try {
    const audio = require("../services/transcriptionAudio");
    audio.sweepStaleTempDirs(24 * 3600 * 1000, 50);
  } catch (_unused) {
    // Janitor failure must not block worker boot.
  }
  await startTranscriptionWorker();
  await startRecoveryScheduler();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      logger.info("transcription_worker_shutdown_signal", { signal });
      stopRecoveryScheduler();
      stopTranscriptionWorker()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

if (require.main === module) {
  runAsMain().catch((err) => {
    logger.error("transcription_worker_start_failed", {
      code: err && err.code ? String(err.code) : "UNKNOWN",
    });
    process.exitCode = 1;
  });
}

module.exports = { startTranscriptionWorker, stopTranscriptionWorker, startRecoveryScheduler, stopRecoveryScheduler };
