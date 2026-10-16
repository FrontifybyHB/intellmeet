"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const { endMeeting } = require("../services/meetingLifecycleService");

// Thin controller: admission closure and cleanup intent are enforced
// server-side in the lifecycle service. Host-only; idempotent.
const endMeetingHandler = asyncHandler(async (req, res) => {
  const result = await endMeeting({
    meetingIdParam: req.params.id,
    userId: req.user.id,
  });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.status(HTTP_STATUS.OK).json(result);
});

module.exports = { endMeetingHandler };
