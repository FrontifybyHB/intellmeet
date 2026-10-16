"use strict";

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { observeRateLimited } = require("../utils/joinMetrics");

// Bounded in-process rate limiter for POST /api/meetings/:id/join.
// Keyed on authenticated user + meeting so legitimate reconnects (a few
// joins per minute) pass while token-minting bursts are rejected with
// 429 + Retry-After. A second per-user bucket bounds abuse spread across
// many meetings from one identity without punishing shared-IP users
// (no IP dimension is used).
//
// SINGLE-INSTANCE LIMITATION: counters live in this process only. Behind
// multiple Express replicas, each replica enforces its own budget, so the
// effective global budget scales with replica count. For multi-instance
// deployments, replace with atomic shared counters (Redis INCR + EXPIRE)
// before relying on the limit for abuse protection.
const MAX_ENTRIES = 5000;
const SWEEP_EVERY_OPS = 128;
const SWEEP_MAX_REMOVALS = 200;

const buckets = new Map();
let opsSinceSweep = 0;

function getLimits() {
  const env = getEnv();
  const perMeetingMax = Number.isInteger(env.joinRateLimitMax)
    ? env.joinRateLimitMax
    : 30;
  const perUserMax = perMeetingMax * 4;
  const windowMs = Number.isInteger(env.joinRateLimitWindowMs)
    ? env.joinRateLimitWindowMs
    : 60000;
  return { perMeetingMax, perUserMax, windowMs };
}

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

// Fixed-window take; returns seconds until reset when rejected, else 0.
function takeSlot(key, max, windowMs, now) {
  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    if (!entry && buckets.size >= MAX_ENTRIES) {
      // Bounded memory: evict the oldest key rather than growing.
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

function joinRateLimit(req, res, next) {
  let limits;
  try {
    limits = getLimits();
  } catch (err) {
    next(err);
    return;
  }
  const userId = req.user && req.user.id;
  const meetingId = req.params && req.params.id;
  if (typeof userId !== "string" || userId.length === 0) {
    next();
    return;
  }
  const now = Date.now();
  opsSinceSweep += 1;
  if (opsSinceSweep >= SWEEP_EVERY_OPS) {
    opsSinceSweep = 0;
    sweepExpired(now);
  }

  const meetingKey =
    typeof meetingId === "string" && meetingId.length > 0
      ? `join:m:${userId}:${meetingId}`
      : null;
  const userKey = `join:u:${userId}`;
  const retryAfterMeeting = meetingKey
    ? takeSlot(meetingKey, limits.perMeetingMax, limits.windowMs, now)
    : 0;
  const retryAfterUser = takeSlot(userKey, limits.perUserMax, limits.windowMs, now);
  const retryAfter = Math.max(retryAfterMeeting, retryAfterUser);
  if (retryAfter > 0) {
    observeRateLimited();
    try {
      res.setHeader("Retry-After", String(retryAfter));
    } catch (_unused) {
      // Header failures must not mask the 429 decision.
    }
    next(
      new AppError(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        "Too many join attempts. Please retry shortly.",
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

function sizeForTests() {
  return buckets.size;
}

module.exports = joinRateLimit;
module.exports.resetForTests = resetForTests;
module.exports.sizeForTests = sizeForTests;
module.exports.MAX_ENTRIES = MAX_ENTRIES;
