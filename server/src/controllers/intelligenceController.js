"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const {
  enqueueIntelligence,
  cancelIntelligence,
  getIntelligenceStatus,
  listActionItems,
  reviewActionItem,
  createActionTask,
} = require("../services/intelligenceService");

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

// Host-only schedule/retry. Idempotent: a live run is returned as-is;
// a terminal run is superseded by a NEW run version after fresh
// eligibility checks. The client selects only the recording;
// model/source/versions are server-bound.
const startIntelligence = asyncHandler(async (req, res) => {
  const result = await enqueueIntelligence({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
    manual: true,
  });
  noStore(res);
  const status = result.pending === true ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK;
  res.status(status).json(result);
});

const cancelIntelligenceHandler = asyncHandler(async (req, res) => {
  const result = await cancelIntelligence({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

// Member read of the PUBLISHED intelligence. Unpublished runs return
// status only (no staged output leaks).
const getIntelligenceHandler = asyncHandler(async (req, res) => {
  const result = await getIntelligenceStatus({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

// Member cursor list of suggestions for the latest run version.
const listActionItemsHandler = asyncHandler(async (req, res) => {
  const result = await listActionItems({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
    cursor: req.query.cursor,
    limit: req.query.limit,
    state: req.query.state,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

// Host-only review (approve/edit/reject) with optimistic versioning.
// Owner choice is explicit and verified; only approved items can become tasks.
const reviewActionItemHandler = asyncHandler(async (req, res) => {
  const result = await reviewActionItem({
    meetingIdParam: req.params.id,
    itemIdParam: req.params.itemId,
    userId: req.user.id,
    body: req.body,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

// Idempotent task materialization: one Task per approved suggestion,
// bounded by the suggestion's taskIdempotencyKey. 201 on first create,
// 200 when the same Task is resumed (duplicate POST or timeout replay).
const createActionTaskHandler = asyncHandler(async (req, res) => {
  const result = await createActionTask({
    meetingIdParam: req.params.id,
    itemIdParam: req.params.itemId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(result.resumed ? HTTP_STATUS.OK : HTTP_STATUS.CREATED).json(result);
});

module.exports = {
  startIntelligence,
  cancelIntelligenceHandler,
  getIntelligenceHandler,
  listActionItemsHandler,
  reviewActionItemHandler,
  createActionTaskHandler,
};
