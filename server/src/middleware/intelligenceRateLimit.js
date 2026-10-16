"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");

// Bounded in-process rate limiter for host-only intelligence
// enqueue/retry/cancel/review. Keyed on authenticated user + meeting so
// one host cannot spin superseding runs in a loop. Same
// single-instance discipline as transcriptionRateLimit: per-process
// budgets, documented, with Retry-After on 429.
const MAX_ENTRIES = 2000;
const SWEEP_EVERY_OPS = 64;
const SWEEP_MAX_REMOVALS = 100;

const buckets = new Map();
let opsSinceSweep = 0;

function sweepExpired(now) {
  let removed = 0;
  for (const [key, entry] of buckets) {
    if (removed >= SWEEP_MAX_REMOVALS) {
      break;
    }
    if (entry.resetAt <= now) {
      buckets.delete(key);
      removed += 1;
    }
  }
}

function takeSlot(key, max, windowMs, now) {
  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    if (!entry && buckets.size >= MAX_ENTRIES) {
      const oldest = buckets.keys().next();
      if (!oldest.done) {
        buckets.delete(oldest.value);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }
  if (entry.count < max) {
    entry.count += 1;
    return 0;
  }
  return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

function intelligenceRateLimit(req, res, next) {
  const userId = req.user && req.user.id;
  const meetingId = req.params && req.params.id;
  if (typeof userId !== "string" || userId.length === 0) {
    next();
    return;
  }
  const windowMs = 60000;
  const max = 10;
  const now = Date.now();
  opsSinceSweep += 1;
  if (opsSinceSweep >= SWEEP_EVERY_OPS) {
    opsSinceSweep = 0;
    sweepExpired(now);
  }
  const key =
    typeof meetingId === "string" && meetingId.length > 0
      ? `ix:${userId}:${meetingId}`
      : `ix:${userId}`;
  const retryAfter = takeSlot(key, max, windowMs, now);
  if (retryAfter > 0) {
    try {
      res.setHeader("Retry-After", String(retryAfter));
    } catch (_unused) {
      // Header failures must not mask the 429 decision.
    }
    next(
      new AppError(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        "Too many intelligence requests. Please retry shortly.",
        "RATE_LIMITED"
      )
    );
    return;
  }
  next();
}

function resetForTests() {
  buckets.clear();
  opsSinceSweep = 0;
}

module.exports = intelligenceRateLimit;
module.exports.resetForTests = resetForTests;
