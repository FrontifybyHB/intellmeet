"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const { getHistory } = require("../services/chatService");

// Authorized bounded history for reconnects and scrollback.
// Contract: GET /api/meetings/:id/messages?limit&cursor&direction
// -> { messages asc, nextCursor, hasMore }. Auth via requireAuth,
// membership via the shared access service on every page.
const listMessages = asyncHandler(async (req, res) => {
  const result = await getHistory({
    meetingIdParam: req.params.id,
    userId: req.user.id,
    limit: req.query.limit,
    cursor: req.query.cursor,
    direction: req.query.direction,
  });
  // Private data: never stored by browsers or proxies.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.status(HTTP_STATUS.OK).json(result);
});

module.exports = { listMessages };
