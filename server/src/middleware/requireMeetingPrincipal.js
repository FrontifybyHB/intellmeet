"use strict";

const { AUTH_LIMITS } = require("../constants/authLimits");
const { verifyGuestToken } = require("../services/tokenService");
const requireAuth = require("./requireAuth");

// Account auth remains the default. This narrow middleware only accepts the
// guest cookie on meeting-scoped routes and never exposes it as req.user.
function requireMeetingPrincipal(req, res, next) {
  if (req.cookies && req.cookies[AUTH_LIMITS.GUEST_COOKIE]) {
    try {
      const payload = verifyGuestToken(req.cookies[AUTH_LIMITS.GUEST_COOKIE]);
      req.meetingPrincipal = {
        kind: "guest",
        id: String(payload.sub),
        meetingId: String(payload.meetingId),
        displayName: String(payload.displayName),
      };
      next();
      return;
    } catch (_unused) {
      // Fall through to account auth so an expired guest cookie cannot mask
      // a valid account session.
    }
  }
  requireAuth(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    req.meetingPrincipal = { kind: "user", id: req.user.id };
    next();
  });
}

module.exports = requireMeetingPrincipal;
