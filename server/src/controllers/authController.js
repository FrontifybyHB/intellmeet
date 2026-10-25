"use strict";

const crypto = require("node:crypto");

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { AUTH_LIMITS } = require("../constants/authLimits");
const User = require("../models/User");
const {
  validateRegister,
  validateLogin,
  validateChangePassword,
} = require("../validation/authValidation");
const {
  hashPassword,
  verifyPassword,
  dummyVerify,
  validateNewPassword,
} = require("../services/passwordService");
const {
  newLoginContext,
  mintAccessToken,
  mintRefreshToken,
  verifyRefreshToken,
  peekPayload,
  PURPOSE_REFRESH,
} = require("../services/tokenService");

function safeUserDto(user) {
  return {
    id: String(user._id),
    name: user.name || null,
    email: user.email,
    role: user.role || "user",
  };
}

function cookieFlags() {
  // Secure in production https (always, and forced for the cross-site
  // None mode — loadEnv rejects None outside production). Dev over http
  // keeps host-only cookies without Secure so local login works.
  // SameSite comes from COOKIE_SAMESITE (lax default for same-site
  // deployments; none only as an explicit production cross-site mode).
  const env = getEnv();
  const isProd = env.nodeEnv === "production";
  const sameSite = env.cookieSameSite === "none" ? "none" : "lax";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite,
    path: "/",
  };
}

function setAuthCookies(res, { accessToken, accessExpiresIn, refreshToken, refreshExpiresIn, csrfToken }) {
  const flags = cookieFlags();
  res.cookie(AUTH_LIMITS.ACCESS_COOKIE, accessToken, {
    ...flags,
    maxAge: accessExpiresIn * 1000,
  });
  if (refreshToken) {
    res.cookie(AUTH_LIMITS.REFRESH_COOKIE, refreshToken, {
      ...flags,
      path: "/api/auth",
      maxAge: refreshExpiresIn * 1000,
    });
  }
  if (csrfToken) {
    res.cookie(AUTH_LIMITS.CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: flags.secure,
      sameSite: flags.sameSite,
      path: "/",
    });
  }
}

function clearAuthCookies(res) {
  const flags = cookieFlags();
  res.clearCookie(AUTH_LIMITS.ACCESS_COOKIE, { ...flags });
  res.clearCookie(AUTH_LIMITS.ACCESS_COOKIE, { ...flags, path: "/api/auth" });
  res.clearCookie(AUTH_LIMITS.REFRESH_COOKIE, { ...flags, path: "/api/auth" });
  res.clearCookie(AUTH_LIMITS.REFRESH_COOKIE, { ...flags });
  res.clearCookie(AUTH_LIMITS.CSRF_COOKIE, {
    httpOnly: false,
    secure: flags.secure,
    sameSite: flags.sameSite,
    path: "/",
  });
}

// Signed stateless CSRF token: HMAC(master, "csrf:"+binding) where the
// binding is the current signed login-context id (jti) when
// authenticated, else "anonymous" for the pre-login bootstrap. No
// server store; verification recomputes the HMAC over a candidate set.
function mintCsrfToken(binding) {
  const secret = (getEnv().jwtSecret || "");
  return crypto
    .createHmac("sha256", secret)
    .update(`csrf:${String(binding)}`)
    .digest("base64url");
}

function csrfBindingFor(req) {
  if (req.user && req.user.jti) {
    return req.user.jti;
  }
  const raw =
    req.cookies && req.cookies[AUTH_LIMITS.REFRESH_COOKIE];
  if (typeof raw === "string" && raw) {
    const peeked = peekPayload(raw);
    if (peeked && typeof peeked.jti === "string" && peeked.jti) {
      return peeked.jti;
    }
  }
  return "anonymous";
}

// POST /api/auth/register — validated signup, ordinary role only.
// Atomic single insert (unique index guards simultaneous duplicates).
// Duplicate policy: 409 DUPLICATE_EMAIL (explicit; registration never
// auto-logs-in, so no branch reveals more).
async function registerHandler(req, res, next) {
  try {
    const { name, email, password } = validateRegister(req.body);
    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await User.create({
        name,
        email,
        passwordHash,
        role: "user",
        status: "active",
        authVersion: 0,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        throw new AppError(
          HTTP_STATUS.CONFLICT,
          "An account with that email already exists.",
          "DUPLICATE_EMAIL"
        );
      }
      throw err;
    }
    res.status(201).json({ user: safeUserDto(user) });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/login — generic failure for wrong/unknown/disabled;
// dummy Argon2id verify for missing users; fresh jti + absolute login
// deadline on every success. Cookies only: no tokens in the JSON body.
async function loginHandler(req, res, next) {
  try {
    const { email, password } = validateLogin(req.body);
    const user = await User.findOne(
      { email },
      { email: 1, name: 1, role: 1, status: 1, passwordHash: 1, authVersion: 1 }
    );
    if (!user || !user.passwordHash) {
      await dummyVerify(typeof password === "string" ? password : "x");
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Invalid email or password.",
        "INVALID_CREDENTIALS"
      );
    }
    if (user.status !== "active") {
      await dummyVerify(password);
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Invalid email or password.",
        "INVALID_CREDENTIALS"
      );
    }
    const { ok, needsRehash } = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Invalid email or password.",
        "INVALID_CREDENTIALS"
      );
    }
    // Safe conditional rehash: only replaces the exact hash verified,
    // so a concurrent password change is never clobbered.
    if (needsRehash) {
      try {
        const fresh = await hashPassword(password);
        await User.updateOne(
          { _id: user._id, passwordHash: user.passwordHash },
          { $set: { passwordHash: fresh } }
        );
      } catch (_unused) {
        // Rehash is best-effort; login itself succeeded.
      }
    }
    const ctx = newLoginContext();
    const authVersion = user.authVersion || 0;
    const access = mintAccessToken({
      userId: user._id,
      authVersion,
      jti: ctx.jti,
      loginDeadline: ctx.loginDeadline,
    });
    const refresh = mintRefreshToken({
      userId: user._id,
      authVersion,
      jti: ctx.jti,
      loginDeadline: ctx.loginDeadline,
    });
    const csrfToken = mintCsrfToken(ctx.jti);
    setAuthCookies(res, {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiresIn,
      csrfToken,
    });
    res.status(200).json({ user: safeUserDto(user), csrfToken });
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/me — whitelisted DTO from the current User row, never
// the JWT payload as a profile.
async function meHandler(req, res, next) {
  try {
    const user = await User.findById(req.user.id, {
      email: 1,
      name: 1,
      role: 1,
      status: 1,
    }).lean();
    if (!user || user.status !== "active") {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Authentication required.",
        "UNAUTHORIZED"
      );
    }
    res.status(200).json({ user: safeUserDto(user) });
  } catch (err) {
    next(err);
  }
}

function refreshTokenFrom(req) {
  // Cookie-only transport (P0 boundary): the refresh JWT is accepted
  // exclusively from the HttpOnly im_rt cookie. JSON bodies, headers
  // and query strings are never credential paths.
  if (req.cookies && typeof req.cookies[AUTH_LIMITS.REFRESH_COOKIE] === "string") {
    const v = req.cookies[AUTH_LIMITS.REFRESH_COOKIE].trim();
    if (v) {
      return v;
    }
  }
  return null;
}

// POST /api/auth/refresh — validates the refresh JWT (purpose,
// signature, expiry, issuer/audience) + current User state, then mints
// a NEW short access cookie bounded by the REMAINING absolute login
// lifetime (lb claim). The refresh JWT itself is NOT rotated or
// extended: replacement-only, no consumption state. A copied refresh
// JWT therefore stays usable until its absolute expiry or a User
// authVersion change — stated limit, not a silent guarantee. At expiry
// the client needs a fresh password login.
async function refreshHandler(req, res, next) {
  try {
    const presented = refreshTokenFrom(req);
    if (!presented) {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Refresh token required.",
        "INVALID_REFRESH"
      );
    }
    let payload;
    try {
      payload = verifyRefreshToken(presented);
    } catch (err) {
      if (err && err.code === "AUTH_MISCONFIGURED") {
        throw new AppError(
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          "Authentication is not configured.",
          "AUTH_MISCONFIGURED"
        );
      }
      if (err && err.code === "TOKEN_EXPIRED") {
        throw new AppError(
          HTTP_STATUS.UNAUTHORIZED,
          "Login has expired. Please sign in again.",
          "LOGIN_EXPIRED"
        );
      }
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Invalid refresh token.",
        "INVALID_REFRESH"
      );
    }
    void PURPOSE_REFRESH;
    const user = await User.findById(
      payload.sub,
      { email: 1, name: 1, role: 1, status: 1, authVersion: 1 }
    );
    if (!user || user.status !== "active") {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Invalid refresh token.",
        "INVALID_REFRESH"
      );
    }
    if ((user.authVersion || 0) !== (payload.ver || 0)) {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Credentials have been invalidated. Please sign in again.",
        "STALE_CREDENTIALS"
      );
    }
    const access = mintAccessToken({
      userId: user._id,
      authVersion: user.authVersion || 0,
      jti: payload.jti,
      loginDeadline: payload.lb,
    });
    setAuthCookies(res, {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
    });
    res.status(200).json({ user: safeUserDto(user) });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/logout — clears access/refresh/CSRF cookies with
// matching scopes; idempotent. HONEST LIMIT: this is browser logout.
// It stops normal credential submission, but a copied unexpired JWT
// remains usable until expiry or a User authVersion change. Ordinary
// logout deliberately does NOT bump the global version (that would log
// out the user's other devices too).
async function logoutHandler(req, res, next) {
  try {
    clearAuthCookies(res);
    res.status(200).json({ ok: true });
    void req;
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/logout-all — atomically increments the User
// authVersion (one existing field, no session store) and clears
// current cookies. All old-version app tokens fail on subsequent
// checks. Same-process live sockets are evicted; cross-replica and
// in-flight checks converge on next validation (documented boundary).
async function logoutAllHandler(req, res, next) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Authentication required.",
        "UNAUTHORIZED"
      );
    }
    await User.findByIdAndUpdate(userId, { $inc: { authVersion: 1 } });
    evictUserSockets(userId);
    clearAuthCookies(res);
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/auth/change-password — verifies the current password,
// then atomically swaps the hash AND bumps authVersion conditional on
// the EXACT verified (version, hash) pair: a login/refresh verified
// against the old password can never be relabeled with the new
// version, and a concurrent change elsewhere yields 409 instead of a
// lost update. All old-version tokens die on subsequent checks.
// Requires fresh login afterward (cookies cleared).
// In-flight race boundary: checks that COMPLETED before the version
// bump may still act within their short window; the bump only gates
// subsequent validations. Stated, not solved, without a store.
async function changePasswordHandler(req, res, next) {
  try {
    const { currentPassword, newPassword } = validateChangePassword(req.body);
    validateNewPassword(newPassword);
    const userId = req.user && req.user.id;
    const user = await User.findById(userId, {
      passwordHash: 1,
      authVersion: 1,
      status: 1,
    });
    if (!user || user.status !== "active") {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Authentication required.",
        "UNAUTHORIZED"
      );
    }
    const capturedHash = user.passwordHash || "";
    const capturedVer = user.authVersion || 0;
    const { ok } = await verifyPassword(currentPassword, capturedHash);
    if (!ok) {
      throw new AppError(
        HTTP_STATUS.UNAUTHORIZED,
        "Current password is incorrect.",
        "INVALID_CURRENT_PASSWORD"
      );
    }
    const nextHash = await hashPassword(newPassword);
    const updated = await User.findOneAndUpdate(
      { _id: userId, authVersion: capturedVer, passwordHash: capturedHash },
      {
        $set: { passwordHash: nextHash, passwordUpdatedAt: new Date() },
        $inc: { authVersion: 1 },
      },
      { new: true }
    );
    if (!updated) {
      throw new AppError(
        HTTP_STATUS.CONFLICT,
        "Credentials changed elsewhere. Please retry.",
        "VERSION_CONFLICT"
      );
    }
    evictUserSockets(userId);
    clearAuthCookies(res);
    res.status(200).json({ ok: true, requireRelogin: true });
  } catch (err) {
    next(err);
  }
}

// Evict live sockets for a user-wide version invalidation. Best
// effort, same process; cross-replica converges on next handshake.
function evictUserSockets(userId) {
  try {
    const meetingSockets = require("../sockets/meetingSockets");
    if (typeof meetingSockets.revokeUserSockets === "function") {
      meetingSockets.revokeUserSockets({ userId: String(userId) });
    }
  } catch (_unused) {
    // Socket eviction must never fail the HTTP invalidation.
  }
}

// GET /api/auth/csrf — stateless bootstrap: readable cookie + token
// bound to the current login context (or "anonymous" pre-login).
// Login rotates context (fresh jti), hence fresh CSRF binding.
async function csrfHandler(req, res, _next) {
  const binding = csrfBindingFor(req);
  const token = mintCsrfToken(binding);
  const flags = cookieFlags();
  res.cookie(AUTH_LIMITS.CSRF_COOKIE, token, {
    httpOnly: false,
    secure: flags.secure,
    sameSite: flags.sameSite,
    path: "/",
  });
  res.status(200).json({ csrfToken: token });
}

module.exports = {
  registerHandler,
  loginHandler,
  meHandler,
  refreshHandler,
  logoutHandler,
  logoutAllHandler,
  changePasswordHandler,
  csrfHandler,
  safeUserDto,
  clearAuthCookies,
  mintCsrfToken,
  csrfBindingFor,
};
