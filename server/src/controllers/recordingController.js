"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const { currentNoticeVersion, setConsent, getOwnConsent } = require("../services/consentService");
const {
  startRecording,
  stopRecording,
  listRecordings,
  getRecording,
  accessLink,
} = require("../services/recordingService");
const {
  validateConsentBody,
} = require("../validation/recordingValidation");
const recordingMetrics = require("../utils/recordingMetrics");

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

// Participants change only their OWN preferences (userId from auth).
// Recording control remains host-only; AI transfer is evaluated separately.
const setRecordingConsent = asyncHandler(async (req, res) => {
  const notice = currentNoticeVersion();
  const { decision, aiTransfer } = validateConsentBody(req.body, notice);
  const consent = await setConsent({
    meetingIdParam: req.params.id,
    userId: req.user.id,
    decision,
    aiTransfer,
    noticeVersion: notice,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json({ consent });
});

const getRecordingConsent = asyncHandler(async (req, res) => {
  const result = await getOwnConsent({
    meetingIdParam: req.params.id,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

const startMeetingRecording = asyncHandler(async (req, res) => {
  try {
    const result = await startRecording({
      meetingIdParam: req.params.id,
      userId: req.user.id,
    });
    noStore(res);
    res.status(HTTP_STATUS.OK).json(result);
  } catch (err) {
    // Start timeout is UNKNOWN, not failure: attach the durable
    // attempt so the client reconciles instead of blindly retrying.
    if (err && err.recording) {
      recordingMetrics.observeReject(err.code);
      noStore(res);
      const status = err.statusCode || HTTP_STATUS.SERVICE_UNAVAILABLE;
      res.status(status).json({
        status,
        recording: err.recording,
        error: {
          message: err.message,
          code: err.code,
          requestId: req.id,
        },
      });
      return;
    }
    throw err;
  }
});

const stopMeetingRecording = asyncHandler(async (req, res) => {
  const result = await stopRecording({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

const listMeetingRecordings = asyncHandler(async (req, res) => {
  const result = await listRecordings({
    meetingIdParam: req.params.id,
    userId: req.user.id,
    limit: req.query.limit,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

const getMeetingRecording = asyncHandler(async (req, res) => {
  const recording = await getRecording({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json({ recording });
});

const getRecordingAccessLink = asyncHandler(async (req, res) => {
  const result = await accessLink({
    meetingIdParam: req.params.id,
    recordingIdParam: req.params.recordingId,
    userId: req.user.id,
  });
  noStore(res);
  res.status(HTTP_STATUS.OK).json(result);
});

module.exports = {
  setRecordingConsent,
  getRecordingConsent,
  startMeetingRecording,
  stopMeetingRecording,
  listMeetingRecordings,
  getMeetingRecording,
  getRecordingAccessLink,
};
