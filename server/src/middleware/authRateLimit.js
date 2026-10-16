"use strict";

const crypto = require("node:crypto");

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { AUTH_LIMITS } = require("../constants/authLimits");

// Bounded in-process fixed-window limiters for auth endpoints.
// SINGLE-INSTANCE LIMITATION (documented): counters live per process;
// with multiple replicas each enforces its own budget. Where REDIS_URL
// is configured, replace with atomic INCR+EXPIRE before relying on
// cluster-wide brute-force protection. Local fallback never claims
// cluster protection.
const MAX_ENTRIES = 5000;
const buckets = new Map();
let ops = 0;

function sweep(now) {
  let removed = 0;
  for (const [k, e] of buckets) {
    if (removed >= 200) {
      break;
    }
    if (e.resetAt <= now) {
      buckets.delete(k);
      removed += 1;
    }
  }
}

function take(key, max, windowMs, now) {
  let e = buckets.get(key);
  if (!e || e.resetAt <= now) {
    if (!e && buckets.size >= MAX_ENTRIES) {
      const oldest = buckets.keys().next();
      if (!oldest.done) {
        buckets.delete(oldest.value);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }
  if (e.count < max) {
    e.count += 1;
    return 0;
  }
  return Math.max(1, Math.ceil((e.resetAt - now) / 1000));
}

function clientIp(req) {
  // Forwarded IPs honored only behind a trusted proxy is a deployment
  // setting; Express here does not trust proxy by default, so use the
  // direct remote address only.
  const ra = (req.socket && req.socket.remoteAddress) || "";
  const fwd = req.headers && req.headers["x-forwarded-for"];
  void fwd;
  const raw = Array.isArray(ra) ? ra[0] : String(ra);
  return crypto.createHash("sha256").update(raw || "unknown").digest("hex").slice(0, 32);
}

function deny(res, retryAfter, next) {
  try {
    res.setHeader("Retry-After", String(retryAfter));
  } catch (_unused) {
    // never mask the 429
  }
  next(
    new AppError(
      HTTP_STATUS.TOO_MANY_REQUESTS,
      "Too many attempts. Please retry shortly.",
      "RATE_LIMITED"
    )
  );
}

function windowMs() {
  return AUTH_LIMITS.AUTH_WINDOW_MS;
}

function registerLimit(req, res, next) {
  const now = Date.now();
  ops += 1;
  if (ops >= 128) {
    ops = 0;
    sweep(now);
  }
  const retry = take(
    `reg:${clientIp(req)}`,
    AUTH_LIMITS.REGISTER_PER_IP_MAX,
    windowMs(),
    now
  );
  if (retry > 0) {
    deny(res, retry, next);
    return;
  }
  next();
}

function loginLimit(req, res, next) {
  const now = Date.now();
  ops += 1;
  if (ops >= 128) {
    ops = 0;
    sweep(now);
  }
  let emailKey = "unknown";
  try {
    const raw =
      req.body && typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "unknown";
    emailKey = crypto
      .createHash("sha256")
      .update(raw.slice(0, 254))
      .digest("hex")
      .slice(0, 32);
  } catch (_unused) {
    emailKey = "unknown";
  }
  const r1 = take(
    `login:ip:${clientIp(req)}`,
    AUTH_LIMITS.LOGIN_PER_IP_MAX,
    windowMs(),
    now
  );
  const r2 = take(
    `login:em:${emailKey}`,
    AUTH_LIMITS.LOGIN_PER_EMAIL_MAX,
    windowMs(),
    now
  );
  const retry = Math.max(r1, r2);
  if (retry > 0) {
    deny(res, retry, next);
    return;
  }
  next();
}

function refreshLimit(req, res, next) {
  const now = Date.now();
  ops += 1;
  if (ops >= 128) {
    ops = 0;
    sweep(now);
  }
  let sessKey = "unknown";
  try {
    const raw =
      (req.cookies && req.cookies[AUTH_LIMITS.REFRESH_COOKIE]) ||
      (req.body && req.body.refreshToken) ||
      "unknown";
    sessKey = crypto
      .createHash("sha256")
      .update(String(raw).slice(0, 256))
      .digest("hex")
      .slice(0, 32);
  } catch (_unused) {
    sessKey = "unknown";
  }
  const retry = take(
    `refresh:${sessKey}`,
    AUTH_LIMITS.REFRESH_PER_SESSION_MAX,
    windowMs(),
    now
  );
  if (retry > 0) {
    deny(res, retry, next);
    return;
  }
  next();
}

function passwordChangeLimit(req, res, next) {
  const now = Date.now();
  ops += 1;
  if (ops >= 128) {
    ops = 0;
    sweep(now);
  }
  const userId = (req.user && req.user.id) || "anon";
  const retry = take(
    `pw:${userId}:${clientIp(req)}`,
    AUTH_LIMITS.PASSWORD_CHANGE_MAX,
    windowMs(),
    now
  );
  if (retry > 0) {
    deny(res, retry, next);
    return;
  }
  next();
}

function resetForTests() {
  buckets.clear();
  ops = 0;
}

void getEnv;

module.exports = {
  registerLimit,
  loginLimit,
  refreshLimit,
  passwordChangeLimit,
  resetForTests,
};
