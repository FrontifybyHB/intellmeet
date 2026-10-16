"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const { listMeetings, getMeetingDetail } = require("../services/meetingHistoryService");

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

// Entitled meeting history: hosted or admitted, newest-first,
// projected summaries only (no blobs, no profile lookups).
const listMeetingsHandler = asyncHandler(async (req, res) => {
  const result = await listMeetings({
    userId: req.user.id,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

// Meeting detail: summary + recording/transcription/intelligence
// status pointers. Large content loads via the existing bounded
// endpoints; reads never enqueue work or create tasks.
const getMeetingDetailHandler = asyncHandler(async (req, res) => {
  const result = await getMeetingDetail({
    meetingIdParam: req.params.id,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

module.exports = { listMeetingsHandler, getMeetingDetailHandler };
