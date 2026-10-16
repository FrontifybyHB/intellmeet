"use strict";

const crypto = require("node:crypto");

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { AUTH_LIMITS } = require("../constants/authLimits");
const { csrfBindingFor } = require("../controllers/authController");

// CSRF defense for cookie-authenticated state changes (login,
// register, refresh, logout, password change, global invalidation).
// Stateless signed double-submit: the readable im_csrf cookie must
// match the x-csrf-token header AND equal HMAC(master, login-context)
// for a candidate binding. No server store, no synchronizer tokens.
// Cookie-only transport (P0 boundary): there is NO Bearer exemption —
// every state-changing request proves same-origin via this token.
// SameSite/CORS alone are not relied on; provider webhooks never pass
// through here (signature-verified raw body at their own routes).
function expectedToken(binding) {
  const secret = getEnv().jwtSecret || "";
  return crypto
    .createHmac("sha256", secret)
    .update(`csrf:${String(binding)}`)
    .digest("base64url");
}

function csrfProtect(req, _res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const cookie =
    req.cookies && typeof req.cookies[AUTH_LIMITS.CSRF_COOKIE] === "string"
      ? req.cookies[AUTH_LIMITS.CSRF_COOKIE]
      : null;
  const header = req.headers && req.headers[AUTH_LIMITS.CSRF_HEADER];
  const sent = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string" || typeof sent !== "string" || !cookie || !sent) {
    next(
      new AppError(HTTP_STATUS.FORBIDDEN, "CSRF token missing.", "CSRF_REQUIRED")
    );
    return;
  }
  const a = Buffer.from(cookie, "utf8");
  const b = Buffer.from(sent, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    next(
      new AppError(HTTP_STATUS.FORBIDDEN, "CSRF token invalid.", "CSRF_INVALID")
    );
    return;
  }
  // Binding check against candidates: current login context (jti),
  // refresh-credential context, or anonymous pre-login bootstrap.
  // csrfBindingFor() prefers the strongest available context.
  let candidates;
  try {
    const primary = csrfBindingFor(req);
    candidates = [expectedToken(primary), expectedToken("anonymous")];
  } catch (_unused) {
    candidates = [expectedToken("anonymous")];
  }
  let bound = false;
  for (const c of candidates) {
    const x = Buffer.from(cookie, "utf8");
    const y = Buffer.from(c, "utf8");
    if (x.length === y.length && crypto.timingSafeEqual(x, y)) {
      bound = true;
      break;
    }
  }
  if (!bound) {
    next(
      new AppError(HTTP_STATUS.FORBIDDEN, "CSRF token invalid.", "CSRF_INVALID")
    );
    return;
  }
  next();
}

// Origin check for browser state changes: requests with an Origin must
// match CLIENT_URL; non-browser (no Origin) pass. Fail closed.
function enforceOrigin(req, _res, next) {
  const origin = req.headers && req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  let clientUrl;
  try {
    clientUrl = getEnv().clientUrl;
  } catch (err) {
    next(err);
    return;
  }
  if (clientUrl && origin === clientUrl) {
    next();
    return;
  }
  next(new AppError(HTTP_STATUS.FORBIDDEN, "Origin not allowed.", "FORBIDDEN"));
}

module.exports = { csrfProtect, enforceOrigin };
