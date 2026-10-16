"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const {
  enqueueTranscription,
  cancelTranscription,
  getTranscriptionStatus,
  listTranscript,
} = require("../services/transcriptionService");

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

// Host-only manual enqueue/retry. Idempotent: a live run is returned
// as-is; a terminal run is superseded by a NEW run version after fresh
// eligibility checks. The client cannot select model, remote URL, or
// another meeting's recording id (all server-bound).
const startTranscription = asyncHandler(async (req, res) => {
  const result = await enqueueTranscription({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
    manual: true,
  });
  noStore(res);
  const status = result.pending === true ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK;
  res.status(status).json(result);
});

const cancelTranscriptionHandler = asyncHandler(async (req, res) => {
  const result = await cancelTranscription({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

const getTranscriptionStatusHandler = asyncHandler(async (req, res) => {
  const status = await getTranscriptionStatus({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(status);
});

// Bounded cursor-segment read of the PUBLISHED transcript. Partial
// (staged) output is served only on explicit ?partial=true and is
// labeled in the response; it is never the default.
const listTranscriptHandler = asyncHandler(async (req, res) => {
  const result = await listTranscript({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
    cursor: req.query.cursor,
    limit: req.query.limit,
    partial: req.query.partial,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

module.exports = {
  startTranscription,
  cancelTranscriptionHandler,
  getTranscriptionStatusHandler,
  listTranscriptHandler,
};
