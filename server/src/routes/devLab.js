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
        "into a private file for later review. The host controls capture and " +
        "late joiners keep normal media permissions. Your recording preference " +
        "does not permit AI or third-party transfer; that is a separate decision.",
    },
    routes: {
      create: "POST /api/meetings { title } (link-admission mode; returns meetingId + joinUrl)",
      admit: "POST /api/meetings/:id/members { userId } (host)",
      resolveLink: "GET /api/meeting-links/:code (auth; safe metadata only, never admits)",
      joinLink: "POST /api/meeting-links/:code/join (auth + CSRF; explicit Join admits ordinary participant + shared join token)",
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
      intelligence: "POST /api/meetings/:id/recordings/:recordingId/intelligence (host; ended + ready + complete transcript + transfer consent)",
      intelligenceStatus: "GET /api/meetings/:id/recordings/:recordingId/intelligence",
      cancelIntelligence: "DELETE /api/meetings/:id/recordings/:recordingId/intelligence (host)",
      actionItems: "GET /api/meetings/:id/recordings/:recordingId/action-items?cursor=&limit=&state= (member; latest run version)",
      reviewActionItem: "PATCH /api/meetings/:id/action-items/:itemId { action: approve|edit|reject, version, title?, detail?, dueDateText?, ownerUserId?|confirmUnassigned } (host)",
      createTask: "POST /api/meetings/:id/action-items/:itemId/task (host; approved only; idempotent on taskIdempotencyKey; 201 first, 200 resume)",
      history: "GET /api/meetings?cursor=&limit= (member; entitled hosted/admitted summaries, newest-first)",
      detail: "GET /api/meetings/:id (member; summary + recording/transcription/intelligence status pointers, no blobs)",
    },
    transcriptionNotice: {
      text:
        "Transcription sends meeting audio to Google Gemini only after the " +
        "meeting ends AND every captured human approves audio transfer " +
        "(aiTransfer) for the current notice. Recording approval alone is " +
        "insufficient. Withdrawal blocks publication; bytes already sent " +
        "cannot be unsent, but late results are suppressed.",
    },
    twoUserFlow: {
      text:
        "Two-session verification with real team auth (no bypass): session A " +
        "(host) and session B (admitted member) drive join→chat→consent→" +
        "record→end→transcript→intelligence→review; session C (outsider) " +
        "must see 403/404 on every read and write. Media attachment needs " +
        "a live LiveKit room (token issuance alone is not proof); Egress " +
        "and Gemini live paths run only in authorized budgets and are " +
        "otherwise simulated (mock) and labeled as such.",
    },
    intelligenceNotice: {
      text:
        "Intelligence sends transcript TEXT (bounded windows with segment ids, never audio/credentials) to Google Gemini only after the " +
        "meeting ends AND a complete published transcript exists AND every captured human approves transfer " +
        "(aiTransfer) for the current notice. Suggestions are proposals: the reviewer explicitly chooses a verified " +
        "owner and confirms details before anything becomes a task; approved suggestions materialize exactly one task (idempotent).",
    },
    events: ["meeting:ended", "recording:status", "recording:ready", "transcription:status", "transcription:ready", "intelligence:status", "intelligence:ready", "action-item:updated"],
    states: RECORDING_STATES,
    transitions: RECORDING_TRANSITIONS,
    integration: {
      recordingProvider: summary.recordingProvider,
      recordingStorageConfigured: summary.recordingStorageConfigured,
      livekitConfigured: summary.livekitConfigured,
      transcriptionProvider: summary.transcriptionProvider,
      intelligenceProvider: summary.intelligenceProvider,
      geminiConfigured: summary.geminiConfigured,
      redisConfigured: summary.redisConfigured,
    },
  });
});

module.exports = router;
