"use strict";

const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const { AUTH_LIMITS } = require("../constants/authLimits");

// Stateless app-token mint/verify on the vetted jsonwebtoken library
// (no hand-rolled crypto). Two purposes, never interchangeable:
//   access  — short-lived, sent by browsers as an HttpOnly cookie (and
//             accepted as Bearer / socket handshake auth for API clients)
//   refresh — long-lived up to the ABSOLUTE login deadline, cookie only
// Both carry the current User authVersion; global invalidation works by
// bumping that one User field. No server-side session/token store.
// Keys: access signs with JWT_SECRET; refresh signs with a derived key
// (HMAC-SHA256(master, domain)) — separated, no extra secret to manage,
// no hardcoded fallback. Algorithms locked to HS256; issuer/audience
// enforced on every verification.

const ISSUER = "intellmeet";
const AUDIENCE = "intellmeet-app";
const PURPOSE_ACCESS = "access";
const PURPOSE_REFRESH = "refresh";

function masterSecret() {
  // getEnv validated centrally; missing secret is a boot/config error
  // surfaced by callers as AUTH_MISCONFIGURED, never a fallback key.
  const { getEnv } = require("../config/env");
  return getEnv().jwtSecret;
}

function refreshKey(master) {
  return crypto
    .createHmac("sha256", master)
    .update("intellmeet-refresh-v1")
    .digest();
}

function accessTtlFor(remainingLoginSeconds) {
  const ttl = AUTH_LIMITS.ACCESS_TTL_SECONDS;
  if (
    Number.isInteger(remainingLoginSeconds) &&
    remainingLoginSeconds > 0 &&
    remainingLoginSeconds < ttl
  ) {
    return remainingLoginSeconds;
  }
  return ttl;
}

// Starts a fresh login: new random login-context id (jti) shared by the
// pair, absolute deadline lb (unix seconds) shared by the pair.
function newLoginContext(nowSeconds) {
  const issuedAt = Number.isInteger(nowSeconds)
    ? nowSeconds
    : Math.floor(Date.now() / 1000);
  return {
    jti: crypto.randomBytes(16).toString("hex"),
    loginBorn: issuedAt,
    loginDeadline: issuedAt + AUTH_LIMITS.REFRESH_TTL_SECONDS,
  };
}

function mintAccessToken({ userId, authVersion, jti, loginDeadline, nowSeconds }) {
  const master = masterSecret();
  if (!master) {
    const AppError = require("../utils/AppError");
    const { HTTP_STATUS } = require("../constants/httpStatus");
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Authentication is not configured.",
      "AUTH_MISCONFIGURED"
    );
  }
  const now = Number.isInteger(nowSeconds)
    ? nowSeconds
    : Math.floor(Date.now() / 1000);
  const remaining = loginDeadline - now;
  const ttl = accessTtlFor(remaining);
  const token = jwt.sign(
    {
      sub: String(userId),
      purpose: PURPOSE_ACCESS,
      ver: authVersion,
      jti: String(jti),
      lb: loginDeadline,
    },
    master,
    {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: ttl,
    }
  );
  return { token, expiresIn: ttl };
}

function mintRefreshToken({ userId, authVersion, jti, loginDeadline }) {
  const master = masterSecret();
  if (!master) {
    const AppError = require("../utils/AppError");
    const { HTTP_STATUS } = require("../constants/httpStatus");
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Authentication is not configured.",
      "AUTH_MISCONFIGURED"
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = loginDeadline - now;
  if (remaining <= 0) {
    const AppError = require("../utils/AppError");
    const { HTTP_STATUS } = require("../constants/httpStatus");
    throw new AppError(
      HTTP_STATUS.UNAUTHORIZED,
      "Login has expired. Please sign in again.",
      "LOGIN_EXPIRED"
    );
  }
  // Refresh lifetime is the ORIGINAL absolute deadline — never extended.
  const token = jwt.sign(
    {
      sub: String(userId),
      purpose: PURPOSE_REFRESH,
      ver: authVersion,
      jti: String(jti),
      lb: loginDeadline,
    },
    refreshKey(master),
    {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: remaining,
    }
  );
  return { token, expiresIn: remaining };
}

function verifyToken(token, expectedPurpose) {
  const master = masterSecret();
  if (!master) {
    const err = new Error("Authentication is not configured.");
    err.code = "AUTH_MISCONFIGURED";
    throw err;
  }
  const key =
    expectedPurpose === PURPOSE_REFRESH ? refreshKey(master) : master;
  let payload;
  try {
    payload = jwt.verify(token, key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 5,
    });
  } catch (err) {
    // Normalize all library errors (expired, malformed, bad signature,
    // wrong key/audience/issuer) without leaking token detail.
    const e = new Error("Invalid or expired token.");
    e.code =
      err && err.name === "TokenExpiredError"
        ? "TOKEN_EXPIRED"
        : "TOKEN_INVALID";
    throw e;
  }
  if (!payload || payload.purpose !== expectedPurpose) {
    const e = new Error("Invalid or expired token.");
    e.code = "TOKEN_INVALID";
    throw e;
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    const e = new Error("Invalid or expired token.");
    e.code = "TOKEN_INVALID";
    throw e;
  }
  return payload;
}

function verifyAccessToken(token) {
  return verifyToken(token, PURPOSE_ACCESS);
}

function verifyRefreshToken(token) {
  return verifyToken(token, PURPOSE_REFRESH);
}

// Unverified payload peek: ONLY for selecting a CSRF-binding candidate.
// Never used for authorization.
function peekPayload(token) {
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === "object") {
      return decoded;
    }
  } catch (_unused) {
    // Not a JWT: no candidate.
  }
  return null;
}

module.exports = {
  ISSUER,
  AUDIENCE,
  PURPOSE_ACCESS,
  PURPOSE_REFRESH,
  newLoginContext,
  mintAccessToken,
  mintRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  peekPayload,
};
