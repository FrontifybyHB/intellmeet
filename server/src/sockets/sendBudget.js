"use strict";

const { resolveChatLimits } = require("../constants/chatLimits");

// Per-user token-bucket send budget shared across ALL of a user's
// sockets (keyed by server-verified userId, never socket.id), so extra
// tabs or devices cannot multiply the allowance. Defaults: 5 sends/sec
// sustained with burst 10; retries reuse the same clientMessageId so
// legitimate recovery stays inside the budget.
//
// SINGLE-INSTANCE LIMITATION: buckets live in this process only. Behind
// multiple Socket.IO replicas each replica enforces its own budget.
// Cross-replica enforcement needs atomic shared counters (Redis) plus
// the Redis adapter before claiming horizontal readiness.
const MAX_ENTRIES = 10000;
const SWEEP_EVERY_OPS = 256;
const SWEEP_MAX_REMOVALS = 500;

const buckets = new Map();
let opsSinceSweep = 0;

function getBudget() {
  const limits = resolveChatLimits();
  return { perSec: limits.SEND_PER_SEC, burst: limits.SEND_BURST };
}

function sweepStale(now) {
  let removed = 0;
  for (const [key, entry] of buckets) {
    if (removed >= SWEEP_MAX_REMOVALS) {
      break;
    }
    // Entries idle for over a minute carry no useful tokens state.
    if (entry.updatedAt + 60000 <= now) {
      buckets.delete(key);
      removed += 1;
    }
  }
}

// Returns true when the send may proceed, false when the budget is spent.
function takeSendBudget(userId) {
  const { perSec, burst } = getBudget();
  const now = Date.now();
  opsSinceSweep += 1;
  if (opsSinceSweep >= SWEEP_EVERY_OPS) {
    opsSinceSweep = 0;
    sweepStale(now);
  }
  let entry = buckets.get(userId);
  if (!entry) {
    if (buckets.size >= MAX_ENTRIES) {
      const oldest = buckets.keys().next();
      if (!oldest.done) {
        buckets.delete(oldest.value);
      }
    }
    // New users start full so a first burst of legitimate sends passes.
    buckets.set(userId, { tokens: burst - 1, updatedAt: now });
    return true;
  }
  const elapsedSec = (now - entry.updatedAt) / 1000;
  entry.tokens = Math.min(burst, entry.tokens + elapsedSec * perSec);
  entry.updatedAt = now;
  if (entry.tokens < 1) {
    entry.tokens = 0;
    return false;
  }
  entry.tokens -= 1;
  return true;
}

function resetForTests() {
  buckets.clear();
  opsSinceSweep = 0;
}

function sizeForTests() {
  return buckets.size;
}

module.exports = { takeSendBudget, resetForTests, sizeForTests, MAX_ENTRIES };
