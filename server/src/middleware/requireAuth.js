"use strict";

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { AUTH_LIMITS } = require("../constants/authLimits");
const {
  verifyAccessToken,
  PURPOSE_ACCESS,
} = require("../services/tokenService");

function tokenFromRequest(req) {
  // Cookie-only transport (P0 boundary): the access JWT is accepted
  // exclusively from the HttpOnly im_at cookie. Authorization headers,
  // handshake auth tokens, query strings and bodies are never credential
  // paths — requests carrying tokens there are unauthenticated.
  if (
    req.cookies &&
    typeof req.cookies[AUTH_LIMITS.ACCESS_COOKIE] === "string"
  ) {
    const token = req.cookies[AUTH_LIMITS.ACCESS_COOKIE].trim();
    if (token) {
      return token;
    }
  }
  return null;
}

function unauthorized(message, code) {
  return new AppError(
    HTTP_STATUS.UNAUTHORIZED,
    message || "Invalid or expired token.",
    code || "UNAUTHORIZED"
  );
}

// Stateless gate: validates the ACCESS JWT (purpose/signature/expiry +
// explicit issuer/audience/algorithm checks inside tokenService) and
// the CURRENT User security state through an indexed projected read
// (active status + authVersion match). Legacy tokens without the new
// claims are rejected: cutover requires a fresh login, old tokens never
// bypass the new policy. Deleted/disabled users and older-version
// tokens are denied. No stale allow cache. Auth-DB outage fails closed
// with 503 DB_ERROR (never a false logged-out success).
async function requireAuth(req, _res, next) {
  const token = tokenFromRequest(req);
  if (!token) {
    next(unauthorized("Authentication required.", "UNAUTHORIZED"));
    return;
  }
  let secret;
  try {
    secret = getEnv().jwtSecret;
  } catch (err) {
    next(err);
    return;
  }
  if (!secret) {
    next(
      new AppError(
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        "Authentication is not configured.",
        "AUTH_MISCONFIGURED"
      )
    );
    return;
  }
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err && err.code === "AUTH_MISCONFIGURED") {
      next(
        new AppError(
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          "Authentication is not configured.",
          "AUTH_MISCONFIGURED"
        )
      );
      return;
    }
    next(unauthorized());
    return;
  }
  void PURPOSE_ACCESS;
  const userId = payload.sub;
  try {
    const User = require("../models/User");
    const user = await User.findById(userId, {
      status: 1,
      role: 1,
      authVersion: 1,
    }).lean();
    if (!user || user.status !== "active") {
      next(unauthorized());
      return;
    }
    if ((user.authVersion || 0) !== (payload.ver || 0)) {
      next(unauthorized("Invalid or expired token.", "STALE_CREDENTIALS"));
      return;
    }
    req.user = {
      id: String(userId),
      role: user.role || "user",
      ver: user.authVersion || 0,
      jti: typeof payload.jti === "string" ? payload.jti : null,
    };
    next();
  } catch (err) {
    if (err && (err.statusCode === 401 || err.isOperational)) {
      next(err);
      return;
    }
    next(
      new AppError(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "Authentication temporarily unavailable.",
        "DB_ERROR"
      )
    );
  }
}

// Optional variant for POST /logout: attaches req.user when a valid
// access credential is presented, otherwise continues anonymously so
// cookie-only logout still clears browser state.
function optionalAuth(req, _res, next) {
  const token = tokenFromRequest(req);
  if (!token) {
    next();
    return;
  }
  requireAuth(req, _res, (err) => {
    next();
    void err;
  });
}

module.exports = requireAuth;
module.exports.optionalAuth = optionalAuth;
module.exports.tokenFromRequest = tokenFromRequest;
