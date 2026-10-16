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
const {
  startIntelligence,
  cancelIntelligenceHandler,
  getIntelligenceHandler,
  listActionItemsHandler,
  reviewActionItemHandler,
  createActionTaskHandler,
} = require("../controllers/intelligenceController");
const requireAuth = require("../middleware/requireAuth");
const { csrfProtect } = require("../middleware/csrf");
const joinRateLimit = require("../middleware/joinRateLimit");
const transcriptionRateLimit = require("../middleware/transcriptionRateLimit");
const intelligenceRateLimit = require("../middleware/intelligenceRateLimit");
const { joinMeeting } = require("../controllers/meetingJoinController");
const { listMessages } = require("../controllers/meetingMessageController");
const {
  listMeetingsHandler,
  getMeetingDetailHandler,
} = require("../controllers/meetingHistoryController");
const {
  createMeetingHandler,
  admitMemberHandler,
} = require("../controllers/meetingManageController");

const router = express.Router();

// Provisional test-scope management: create + admit so the whole
// flow is exercisable (create → share id → join → …). Team meeting
// CRUD owns the canonical contract; this defers to it when it lands.
router.post("/", requireAuth, csrfProtect, createMeetingHandler);
router.post("/:id/members", requireAuth, csrfProtect, admitMemberHandler);

// Phase 6: entitled post-meeting reads. History lists hosted/admitted
// meetings (projected summaries, cursor pages); detail returns status
// pointers only. Large content loads through the existing bounded
// endpoints. Reads never enqueue work or create tasks.
router.get("/", requireAuth, listMeetingsHandler);
router.get("/:id", requireAuth, getMeetingDetailHandler);

router.post("/:id/join", requireAuth, csrfProtect, joinRateLimit, joinMeeting);
router.get("/:id/messages", requireAuth, listMessages);

// Phase 3: consent, recording control, and termination. All
// meeting-scoped and authenticated; host-only paths enforce NOT_HOST
// server-side, participants may change only their own consent row.
// Cookie-authed writes require the double-submit CSRF header;
// there is no Bearer exemption (cookies are the only credential path).
router.post("/:id/recording-consent", requireAuth, csrfProtect, setRecordingConsent);
router.get("/:id/recording-consent", requireAuth, getRecordingConsent);
router.post("/:id/recordings/start", requireAuth, csrfProtect, startMeetingRecording);
router.post(
  "/:id/recordings/:recordingId/stop",
  requireAuth,
  csrfProtect,
  stopMeetingRecording
);
router.get("/:id/recordings", requireAuth, listMeetingRecordings);
router.get("/:id/recordings/:recordingId", requireAuth, getMeetingRecording);
router.get(
  "/:id/recordings/:recordingId/url",
  requireAuth,
  getRecordingAccessLink
);
router.post("/:id/end", requireAuth, csrfProtect, endMeetingHandler);

// Phase 4: post-meeting transcription. Reads use meeting membership
// (authorized subscribers + bounded recovery after room eviction);
// writes are host-only + rate-limited. The client selects only the
// recording; model/source/versions are server-bound.
router.post(
  "/:id/recordings/:recordingId/transcription",
  requireAuth,
  csrfProtect,
  transcriptionRateLimit,
  startTranscription
);
router.delete(
  "/:id/recordings/:recordingId/transcription",
  requireAuth,
  csrfProtect,
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

// Phase 5: evidence-linked meeting intelligence + reviewable action
// suggestions. Reads use meeting membership (authorized subscribers +
// bounded recovery after room eviction); writes are host-only +
// rate-limited. The client selects only the recording; model/source/
// versions are server-bound. Cookie-authed writes require CSRF;
// Bearer requests are exempt.
router.post(
  "/:id/recordings/:recordingId/intelligence",
  requireAuth,
  csrfProtect,
  intelligenceRateLimit,
  startIntelligence
);
router.delete(
  "/:id/recordings/:recordingId/intelligence",
  requireAuth,
  csrfProtect,
  intelligenceRateLimit,
  cancelIntelligenceHandler
);
router.get(
  "/:id/recordings/:recordingId/intelligence",
  requireAuth,
  getIntelligenceHandler
);
router.get(
  "/:id/recordings/:recordingId/action-items",
  requireAuth,
  listActionItemsHandler
);
router.patch(
  "/:id/action-items/:itemId",
  requireAuth,
  csrfProtect,
  intelligenceRateLimit,
  reviewActionItemHandler
);
router.post(
  "/:id/action-items/:itemId/task",
  requireAuth,
  csrfProtect,
  intelligenceRateLimit,
  createActionTaskHandler
);

module.exports = router;
