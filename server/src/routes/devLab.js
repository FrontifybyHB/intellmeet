"use strict";

const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const { getEnv, getSafeEnvSummary } = require("../config/env");
const { currentNoticeVersion } = require("../services/consentService");
const {
  RECORDING_STATES,
  RECORDING_TRANSITIONS,
} = require("../constants/recordingLimits");

const router = express.Router();

// Protected contract lab for Phase 3 (JSON, not production UI).
// Reuses the real auth middleware — no bypass tokens, no debug
// routes, never exposed publicly. Shows the current recording
// notice/version, consent state expectations, control routes, and
// lifecycle states so two-tab manual verification can drive the
// actual API. Secrets are never included (see getSafeEnvSummary).
router.get("/meeting-lab", requireAuth, (req, res) => {
  const summary = getSafeEnvSummary();
  let noticeVersion = null;
  try {
    noticeVersion = currentNoticeVersion();
  } catch (_unused) {
    noticeVersion = null;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.status(200).json({
    userId: req.user.id,
    recordingNotice: {
      version: noticeVersion,
      text:
        "Recording this meeting captures audio and video of all participants " +
        "into a private file for later review. Capture starts only after every " +
        "admitted participant approves this notice. You may decline, and you " +
        "may withdraw approval at any time — withdrawal stops the recording " +
        "and quarantines the file. Approval here never permits AI or " +
        "third-party transfer; that is a separate decision.",
    },
    routes: {
      consent: "POST /api/meetings/:id/recording-consent { decision, noticeVersion, aiTransfer? }",
      consentStatus: "GET /api/meetings/:id/recording-consent",
      start: "POST /api/meetings/:id/recordings/start (host)",
      stop: "POST /api/meetings/:id/recordings/:recordingId/stop (host)",
      list: "GET /api/meetings/:id/recordings",
      end: "POST /api/meetings/:id/end (host)",
      webhook: "POST /api/webhooks/livekit (provider-verified)",
      transcribe: "POST /api/meetings/:id/recordings/:recordingId/transcription (host; ended + ready + transfer consent)",
      transcriptionStatus: "GET /api/meetings/:id/recordings/:recordingId/transcription",
      transcript: "GET /api/meetings/:id/recordings/:recordingId/transcript?cursor=&limit= (&partial=true labels staged output)",
      cancelTranscription: "DELETE /api/meetings/:id/recordings/:recordingId/transcription (host)",
    },
    transcriptionNotice: {
      text:
        "Transcription sends meeting audio to Google Gemini only after the " +
        "meeting ends AND every captured human approves audio transfer " +
        "(aiTransfer) for the current notice. Recording approval alone is " +
        "insufficient. Withdrawal blocks publication; bytes already sent " +
        "cannot be unsent, but late results are suppressed.",
    },
    events: ["meeting:ended", "recording:status", "recording:ready", "transcription:status", "transcription:ready"],
    states: RECORDING_STATES,
    transitions: RECORDING_TRANSITIONS,
    integration: {
      recordingProvider: summary.recordingProvider,
      recordingStorageConfigured: summary.recordingStorageConfigured,
      livekitConfigured: summary.livekitConfigured,
      transcriptionProvider: summary.transcriptionProvider,
      geminiConfigured: summary.geminiConfigured,
      redisConfigured: summary.redisConfigured,
    },
  });
});

module.exports = router;
