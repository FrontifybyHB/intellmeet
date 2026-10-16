"use strict";

const {
  registerHandler,
  loginHandler,
  meHandler,
  refreshHandler,
  logoutHandler,
  logoutAllHandler,
  changePasswordHandler,
  csrfHandler,
} = require("../controllers/authController");
const requireAuth = require("../middleware/requireAuth");
const { optionalAuth } = require("../middleware/requireAuth");
const { csrfProtect, enforceOrigin } = require("../middleware/csrf");
const {
  registerLimit,
  loginLimit,
  refreshLimit,
  passwordChangeLimit,
} = require("../middleware/authRateLimit");

const express = require("express");
const { AUTH_LIMITS } = require("../constants/authLimits");

const router = express.Router();

// Logout with no credentials at all (already-logged-out browser) is a
// trivial success: with no ambient authority there is no CSRF exposure,
// so the CSRF gate is skipped and the handler clears (no-op) + 200.
function skipCsrfWhenAnonymous(req, _res, next) {
  const hasCookie =
    (req.cookies && (req.cookies[AUTH_LIMITS.ACCESS_COOKIE] || req.cookies[AUTH_LIMITS.REFRESH_COOKIE])) ||
    (req.headers && typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer "));
  if (hasCookie) {
    csrfProtect(req, _res, next);
    return;
  }
  next();
}

// POST /api/auth/register — validated signup, ordinary role only.
// Pre-login anonymous CSRF bootstrap + Origin check apply.
router.post("/register", enforceOrigin, registerLimit, csrfProtect, registerHandler);
// POST /api/auth/login — fresh login context + cookies (no tokens in body).
router.post("/login", enforceOrigin, loginLimit, csrfProtect, loginHandler);
// GET /api/auth/me — current user DTO from trusted identity + User row.
router.get("/me", requireAuth, meHandler);
// POST /api/auth/refresh — new access cookie bounded by the ORIGINAL
// absolute login deadline; refresh JWT never extended or rotated.
router.post("/refresh", refreshLimit, csrfProtect, refreshHandler);
// POST /api/auth/logout — clears cookies, idempotent. Browser logout:
// copied JWTs stay valid until expiry/version change (documented).
router.post("/logout", optionalAuth, skipCsrfWhenAnonymous, logoutHandler);
// POST /api/auth/logout-all — atomic User authVersion bump (global
// invalidation via one existing field) + cookie clear.
router.post("/logout-all", requireAuth, csrfProtect, logoutAllHandler);
// PATCH /api/auth/change-password — conditional hash+version swap,
// fresh login required afterward.
router.patch(
  "/change-password",
  requireAuth,
  passwordChangeLimit,
  csrfProtect,
  changePasswordHandler
);
// GET /api/auth/csrf — stateless CSRF bootstrap.
// NOTE: no per-device session listing/revocation endpoints exist in
// this design (no registry to list from).
router.get("/csrf", csrfHandler);

module.exports = router;
