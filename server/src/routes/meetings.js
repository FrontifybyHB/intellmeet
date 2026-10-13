"use strict";

const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const joinRateLimit = require("../middleware/joinRateLimit");
const { joinMeeting } = require("../controllers/meetingJoinController");
const { listMessages } = require("../controllers/meetingMessageController");

const router = express.Router();

router.post("/:id/join", requireAuth, joinRateLimit, joinMeeting);
router.get("/:id/messages", requireAuth, listMessages);

module.exports = router;
