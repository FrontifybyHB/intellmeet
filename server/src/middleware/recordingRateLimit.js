"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");

// Recording control reaches paid provider work. The durable recording state
// still deduplicates concurrent starts; this is a bounded abuse backstop.
const WINDOW_MS = 60000;
const MAX_PER_MEETING = 20;
const MAX_ENTRIES = 2000;
const buckets = new Map();

function recordingRateLimit(req, res, next) {
  const userId = req.user && req.user.id;
  const meetingId = req.params && req.params.id;
  if (typeof userId !== "string" || typeof meetingId !== "string") {
    next();
    return;
  }
  const now = Date.now();
  const key = `${userId}:${meetingId}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_ENTRIES) {
      buckets.delete(buckets.keys().next().value);
    }
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  if (bucket.count >= MAX_PER_MEETING) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    next(new AppError(HTTP_STATUS.TOO_MANY_REQUESTS, "Too many recording requests. Please retry shortly.", "RATE_LIMITED"));
    return;
  }
  bucket.count += 1;
  next();
}

function resetForTests() {
  buckets.clear();
}

module.exports = recordingRateLimit;
module.exports.resetForTests = resetForTests;
