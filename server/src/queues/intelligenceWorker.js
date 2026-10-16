"use strict";

// Separate intelligence worker entrypoint. Importing this module
// never starts consumption — call startIntelligenceWorker() or run
// `node src/queues/intelligenceWorker.js`. The HTTP/socket server
// process never imports this file.

const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const { INTELLIGENCE_LIMITS } = require("../constants/intelligenceLimits");
const { processIntelligenceJob, workerIdentity } = require("../services/intelligenceRunner");

let activeWorker = null;
let ownedConnection = null;
let recoveryScheduler = null;

// Bounded durable-recovery loop for this worker's lifecycle: requeues
// pending_enqueue intents stranded by crashes/Redis loss and picks up
// stalled runs whose jobs vanished. Lease-claimed and idempotent, so
// concurrent replicas converge safely. Exposed for tests; runAsMain
// starts it with the production interval.
async function startRecoveryScheduler({ intervalMs, jitterMs } = {}) {
  if (recoveryScheduler) {
    return recoveryScheduler;
  }
  const { startRecoveryScheduler: start } = require("./recoveryScheduler");
  const {
    reconcilePendingEnqueues,
    reconcileStrandedRuns,
  } = require("../services/intelligenceRecovery");
  recoveryScheduler = start({
    name: "intelligence",
    intervalMs,
    jitterMs,
    recover: async () => {
      await reconcilePendingEnqueues({});
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

async function startIntelligenceWorker({ connection } = {}) {
  if (activeWorker) {
    return activeWorker;
  }
  const { Worker } = require("bullmq");
  const env = getEnv();
  const workerId = workerIdentity();
  let conn = connection;
  if (!conn) {
    if (!env.redisUrl) {
      throw new Error("REDIS_URL is required to start the intelligence worker.");
    }
    const IORedis = require("ioredis");
    conn = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    ownedConnection = conn;
  }
  activeWorker = new Worker(
    INTELLIGENCE_LIMITS.QUEUE_NAME,
    async (job) => processIntelligenceJob(job, { workerId }),
    {
      connection: conn,
      concurrency: env.intelWorkerConcurrency,
      lockDuration: 60000,
      stalledInterval: 30000,
      maxStalledCount: 3,
    }
  );
  activeWorker.on("completed", (job) => {
    logger.info("intelligence_job_completed", { jobId: job && job.id });
  });
  activeWorker.on("failed", (job, err) => {
    logger.error("intelligence_job_failed", {
      jobId: job && job.id,
      code: err && err.code ? String(err.code) : "UNKNOWN",
    });
  });
  activeWorker.on("error", (err) => {
    logger.error("intelligence_worker_error", {
      code: err && err.code ? String(err.code) : "UNKNOWN",
    });
  });
  logger.info("intelligence_worker_started", {
    concurrency: env.intelWorkerConcurrency,
  });
  return activeWorker;
}

async function stopIntelligenceWorker() {
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
  logger.info("intelligence_worker_stopped", {});
}

async function runAsMain() {
  const connectDB = require("../config/db");
  await connectDB();
  await startIntelligenceWorker();
  await startRecoveryScheduler();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      logger.info("intelligence_worker_shutdown_signal", { signal });
      stopRecoveryScheduler();
      stopIntelligenceWorker()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

if (require.main === module) {
  runAsMain().catch((err) => {
    logger.error("intelligence_worker_start_failed", {
      code: err && err.code ? String(err.code) : "UNKNOWN",
    });
    process.exitCode = 1;
  });
}

module.exports = { startIntelligenceWorker, stopIntelligenceWorker, startRecoveryScheduler, stopRecoveryScheduler };
