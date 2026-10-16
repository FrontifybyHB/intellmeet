"use strict";

const express = require("express");

const {
  setRecordingConsent,
  getRecordingConsent,
  startMeetingRecording,
  stopMeetingRecording,
  listMeetingRecordings,
  getMeetingRecording,
  getRecordingAccessLink,
} = require("../controllers/recordingController");
const { endMeetingHandler } = require("../controllers/meetingEndController");
const {
  startTranscription,
  cancelTranscriptionHandler,
  getTranscriptionStatusHandler,
  listTranscriptHandler,
} = require("../controllers/transcriptionController");
const requireAuth = require("../middleware/requireAuth");
const joinRateLimit = require("../middleware/joinRateLimit");
const transcriptionRateLimit = require("../middleware/transcriptionRateLimit");
const { joinMeeting } = require("../controllers/meetingJoinController");
const { listMessages } = require("../controllers/meetingMessageController");

const router = express.Router();

router.post("/:id/join", requireAuth, joinRateLimit, joinMeeting);
router.get("/:id/messages", requireAuth, listMessages);

// Phase 3: consent, recording control, and termination. All
// meeting-scoped and authenticated; host-only paths enforce NOT_HOST
// server-side, participants may change only their own consent row.
router.post("/:id/recording-consent", requireAuth, setRecordingConsent);
router.get("/:id/recording-consent", requireAuth, getRecordingConsent);
router.post("/:id/recordings/start", requireAuth, startMeetingRecording);
router.post(
  "/:id/recordings/:recordingId/stop",
  requireAuth,
  stopMeetingRecording
);
router.get("/:id/recordings", requireAuth, listMeetingRecordings);
router.get("/:id/recordings/:recordingId", requireAuth, getMeetingRecording);
router.get(
  "/:id/recordings/:recordingId/url",
  requireAuth,
  getRecordingAccessLink
);
router.post("/:id/end", requireAuth, endMeetingHandler);

// Phase 4: post-meeting transcription. Reads use meeting membership
// (authorized subscribers + bounded recovery after room eviction);
// writes are host-only + rate-limited. The client selects only the
// recording; model/source/versions are server-bound.
router.post(
  "/:id/recordings/:recordingId/transcription",
  requireAuth,
  transcriptionRateLimit,
  startTranscription
);
router.delete(
  "/:id/recordings/:recordingId/transcription",
  requireAuth,
  transcriptionRateLimit,
  cancelTranscriptionHandler
);
router.get(
  "/:id/recordings/:recordingId/transcription",
  requireAuth,
  getTranscriptionStatusHandler
);
router.get(
  "/:id/recordings/:recordingId/transcript",
  requireAuth,
  listTranscriptHandler
);

module.exports = router;
