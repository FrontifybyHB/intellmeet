"use strict";

const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const { csrfProtect } = require("../middleware/csrf");
const joinRateLimit = require("../middleware/joinRateLimit");
const {
  resolveLinkHandler,
  joinLinkHandler,
} = require("../controllers/meetingLinkController");

const router = express.Router();

// Invite-link resolution (read-only) and explicit link join. Both
// require cookie auth; the mutating join additionally requires CSRF
// and shares the join abuse budget. No tokens or credentials ever
// appear in URLs.
router.get("/:code", requireAuth, joinRateLimit, resolveLinkHandler);
router.post("/:code/join", requireAuth, csrfProtect, joinRateLimit, joinLinkHandler);

module.exports = router;
