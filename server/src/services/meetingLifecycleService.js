"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const Meeting = require("../models/Meeting");
const Recording = require("../models/Recording");
const { roomNameFor } = require("./meetingJoinService");
const { findNonterminalAttempt, transitionAttempt } = require("./recordingService");
const { serializeRecording } = require("./recordingService");
const provider = require("./recordingProvider");
const logger = require("../config/logger");
const { publishToMeeting, closeMeetingRoom } = require("../sockets/realtime");
const recordingMetrics = require("../utils/recordingMetrics");
const { RECORDING_STATES, NONTERMINAL_STATES } = require("../constants/recordingLimits");

// Host-only meeting termination with race/crash safety.
//
// Ordering (documented, compatible):
//  1. Atomically close app admission: conditional Meeting update to
//     ended (+ endedAt, cleanup intent, closeVersion bump). From this
//     point authorizeJoin/authorizeMeetingAccess deny new tokens, chat
//     sends, history pages, and recording starts.
//  2. Stop any nonterminal recording attempt (durable transition +
//     best-effort provider stop). Provider failure NEVER reopens
//     admission — the attempt stays stopping with a recovery lease.
//  3. Terminate the LiveKit room via the provider (missing room /
//     already-stopped are benign). Media-cleanup completion is a
//     SEPARATE fact from admission closure.
//  4. Broadcast meeting:ended with minimal safe data and remove
//     meeting-room subscriptions on this process.
// Media is never reported ended, and files never reported ready,
// until provider evidence supports it (webhook/recovery paths).

async function endMeeting({ meetingIdParam, userId }) {
  if (
    typeof meetingIdParam !== "string" ||
    !mongoose.Types.ObjectId.isValid(meetingIdParam)
  ) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid meeting id.",
      "INVALID_MEETING_ID"
    );
  }
  // Host check BEFORE terminal-state handling so concurrent/repeated
  // ends are idempotent for the host, while outsiders and participants
  // still get 403 without learning anything beyond denial.
  const meeting = await Meeting.findById(meetingIdParam, {
    hostId: 1,
    status: 1,
    endedAt: 1,
  }).lean();
  if (!meeting) {
    throw new AppError(
      HTTP_STATUS.NOT_FOUND,
      "Meeting not found.",
      "MEETING_NOT_FOUND"
    );
  }
  if (String(meeting.hostId) !== String(userId)) {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Only the host can end the meeting.",
      "NOT_HOST"
    );
  }
  if (meeting.status === "cancelled") {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Meeting was cancelled.",
      "MEETING_CANCELLED"
    );
  }
  if (meeting.status === "ended") {
    return {
      meeting: {
        id: String(meeting._id),
        status: "ended",
        endedAt: meeting.endedAt ? new Date(meeting.endedAt).toISOString() : null,
      },
      alreadyEnded: true,
    };
  }

  const now = new Date();
  const meetingId = meeting._id;
  const closed = await Meeting.findOneAndUpdate(
    { _id: meetingId, status: { $ne: "ended" } },
    {
      $set: {
        status: "ended",
        endedAt: now,
        "mediaCleanup.state": "pending",
        "mediaCleanup.at": now,
      },
      $inc: { closeVersion: 1 },
    },
    { new: true, projection: { _id: 1, status: 1, endedAt: 1, closeVersion: 1 } }
  ).lean();

  if (!closed) {
    // Already ended (concurrent end): idempotent, no resurrection, no
    // duplicate provider storms.
    const current = await Meeting.findById(meetingId, {
      _id: 1,
      status: 1,
      endedAt: 1,
    }).lean();
    return {
      meeting: {
        id: String(meetingId),
        status: current ? current.status : "ended",
        endedAt: current && current.endedAt ? new Date(current.endedAt).toISOString() : null,
      },
      alreadyEnded: true,
    };
  }

  recordingMetrics.observeEnd();
  const sessionId = roomNameFor(meetingId);

  // Durable recording stop: conditional transition first, provider
  // call second. A crash between them leaves a stopping attempt with
  // a lease for recovery — never an orphan recorder we forgot.
  const attempt = await findNonterminalAttempt(meetingId, sessionId);
  if (attempt) {
    const stopping = await transitionAttempt(
      attempt._id,
      attempt.version,
      NONTERMINAL_STATES,
      RECORDING_STATES.STOPPING,
      {}
    );
    if (stopping && stopping.providerEgressId) {
      try {
        await provider.stopEgress({ egressId: stopping.providerEgressId });
      } catch (err) {
        logger.error("end_recording_stop_failed", {
          recordingId: String(attempt._id),
        });
      }
    }
    if (stopping) {
      publishToMeeting(sessionId, "recording:status", {
        meetingId: String(meetingId),
        recording: serializeRecording(
          (await Recording.findById(attempt._id, { state: 1 })) || stopping
        ),
      });
    }
  }

  // Media teardown is best-effort and recorded separately.
  try {
    const roomResult = await provider.deleteLivekitRoom({ roomName: sessionId });
    await Meeting.findOneAndUpdate(
      { _id: meetingId },
      {
        $set: {
          "mediaCleanup.state": roomResult && roomResult.ok ? "done" : "unknown",
          "mediaCleanup.at": new Date(),
          "mediaCleanup.errorCode":
            roomResult && roomResult.ok ? null : "INTEGRATION_BLOCKER",
        },
      }
    ).lean();
  } catch (err) {
    logger.error("end_room_delete_failed", {});
    await Meeting.findOneAndUpdate(
      { _id: meetingId },
      {
        $set: {
          "mediaCleanup.state": "unknown",
          "mediaCleanup.at": new Date(),
        },
      }
    ).lean();
  }

  const endedAt = now.toISOString();
  publishToMeeting(sessionId, "meeting:ended", {
    meetingId: String(meetingId),
    endedAt,
  });
  closeMeetingRoom(String(meetingId), { endedAt });

  // Phase 4: meetings that end with already-ready recordings gain a
  // durable transcription intent when eligible (ended + transfer
  // consent). Best-effort per recording; the reconciler covers gaps.
  try {
    const readyRecordings = await Recording.find(
      { meetingId, state: "ready" },
      { _id: 1 }
    ).lean();
    const { maybeAutoEnqueue } = require("./transcriptionService");
    for (const recording of readyRecordings) {
      try {
        await maybeAutoEnqueue({ meetingId, recordingId: recording._id });
      } catch (_unused) {
        // Per-recording skip; next recording still attempted.
      }
    }
  } catch (_unused) {
    // Auto-enqueue never fails meeting end.
  }

  return {
    meeting: { id: String(meetingId), status: "ended", endedAt },
    alreadyEnded: false,
  };
}

module.exports = { endMeeting };
