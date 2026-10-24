"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const { resolveLink, joinViaLink } = require("../services/meetingShareService");

function noStorePrivate(res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
}

// GET /api/meeting-links/:code — resolve only. Authenticated, safe
// metadata, never admits, never mints tokens, never touches media or
// sockets. Safe against prefetch/crawlers.
const resolveLinkHandler = asyncHandler(async (req, res) => {
  const result = await resolveLink({ code: req.params.code, userId: req.user && req.user.id });
  noStorePrivate(res);
  res.status(HTTP_STATUS.OK).json(result);
});

// POST /api/meeting-links/:code/join — the user's explicit Join action.
// Cookie auth + CSRF (route middleware), then policy-checked idempotent
// admission plus the shared join service token.
const joinLinkHandler = asyncHandler(async (req, res) => {
  const result = await joinViaLink({
    code: req.params.code,
    userId: req.user.id,
  });
  noStorePrivate(res);
  res.status(HTTP_STATUS.OK).json(result);
});

module.exports = { resolveLinkHandler, joinLinkHandler };
