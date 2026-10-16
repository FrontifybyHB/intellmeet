"use strict";

const logger = require("../config/logger");

// Shared bounded recovery scheduler for BullMQ worker lifecycles.
//
// Placement decision: recovery runs ONLY in worker processes
// (runAsMain), never in the HTTP/socket bootstrap. The HTTP server
// stays worker-free by design (lazy queue singletons, no connections
// on import); every reconcile below is lease-claimed and idempotent,
// so any number of worker replicas may schedule it — concurrent ticks
// converge on the atomic claims instead of duplicating work.
//
// Bounds: fixed interval + small jitter (no thundering herd), each
// pass catches its own errors (a failing pass never kills the loop),
// stop() clears the timer for graceful shutdown. Interval default
// 60s matches the enqueue-stuck/stranded thresholds; tests pass a
// short interval explicitly.
function startRecoveryScheduler({ name, intervalMs, jitterMs, recover }) {
  if (typeof recover !== "function") {
    throw new Error("Recovery scheduler requires a recover function.");
  }
  const base = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
  const jitter = Number.isFinite(jitterMs) && jitterMs >= 0 ? jitterMs : 5000;
  let stopped = false;
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await recover();
    } catch (err) {
      // Bounded pass failure is logged with a safe code and dropped —
      // the next tick retries. Never throws out of the loop.
      logger.error("recovery_pass_failed", {
        worker: name || "unknown",
        code: err && err.code ? String(err.code) : "UNKNOWN",
      });
    } finally {
      inFlight = false;
    }
    if (!stopped) {
      schedule();
    }
  }

  function schedule() {
    const delay = base + Math.floor(Math.random() * (jitter + 1));
    timer = setTimeout(tick, delay);
    if (timer && typeof timer.unref === "function") {
      // Worker liveness comes from the BullMQ worker/Redis, never from
      // this janitor timer: unref so tests and shutdown never hang on it.
      timer.unref();
    }
  }

  schedule();
  logger.info("recovery_scheduler_started", { worker: name || "unknown", intervalMs: base });
  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info("recovery_scheduler_stopped", { worker: name || "unknown" });
    },
  };
}

module.exports = { startRecoveryScheduler };
