"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const Meeting = require("../models/Meeting");
const MeetingParticipant = require("../models/MeetingParticipant");
const User = require("../models/User");
const { mintJoinToken } = require("./livekitService");

function roomNameFor(meetingId) {
  return `meeting_${String(meetingId)}`;
}

// Read-only authorization for POST /api/meetings/:id/join.
// - Validates the meeting id (400 on malformed).
// - 404 when the meeting does not exist.
// - 403 when the meeting ended or was cancelled.
// - 403 unless the caller is the host (Meeting.hostId) or has a
//   server-verified MeetingParticipant row with status "admitted".
// Never trusts a client-supplied role. Never creates membership,
// increments joinCount, or marks presence; it only reads Meeting +
// MeetingParticipant and mints a short-lived room token.
//
// Query shape: both reads project only the fields authorization needs
// and use lean() (both schemas have no getters, virtuals, or document
// middleware, so lean is behavior-preserving). Meeting resolves via the
// _id index; membership resolves via the unique (meetingId, userId)
// index. The member path needs two sequential reads because the second
// filter depends on the meeting's _id/hostId; the host path skips the
// second read entirely.
//
// Race note: the reads below are point-in-time checks immediately
// followed by token signing — the sequence is NOT atomic. If admission
// is removed, or the meeting ends, between the check and signing (or
// after issuance), the already-minted token stays usable until its
// short TTL expires. Phase 1 has no provider-side revocation wired in;
// lifecycle changes (removal/end) are owned by the Meeting owner and
// must coordinate there. The short configurable TTL bounds the window.
async function authorizeJoin({ meetingIdParam, userId, userName }) {
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

  const meeting = await Meeting.findById(meetingIdParam, {
    hostId: 1,
    status: 1,
  }).lean();
  if (!meeting) {
    throw new AppError(
      HTTP_STATUS.NOT_FOUND,
      "Meeting not found.",
      "MEETING_NOT_FOUND"
    );
  }
  if (meeting.status === "ended") {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Meeting has ended.",
      "MEETING_ENDED"
    );
  }
  if (meeting.status === "cancelled") {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Meeting was cancelled.",
      "MEETING_CANCELLED"
    );
  }

  const isHost = String(meeting.hostId) === String(userId);
  if (!isHost) {
    const membership = await MeetingParticipant.findOne(
      {
        meetingId: meeting._id,
        userId,
      },
      { status: 1 }
    ).lean();
    if (!membership) {
      throw new AppError(
        HTTP_STATUS.FORBIDDEN,
        "Meeting membership required.",
        "NOT_A_MEMBER"
      );
    }
    if (membership.status !== "admitted") {
      throw new AppError(
        HTTP_STATUS.FORBIDDEN,
        "Meeting membership required.",
        "NOT_ADMITTED"
      );
    }
  }

  const roomName = roomNameFor(meeting._id);
  const profile = typeof userName === "string"
    ? { name: userName }
    : await User.findById(userId, { name: 1 }).lean();
  // Consent-safe admission: when a nonterminal capture is active and
  // this joiner has not approved the current recording notice, issue a
  // subscribe-only token so no new media can enter the captured source
  // before consent. The probe is availability-preserving (never
  // throws): join itself always stays possible so the user can still
  // reach the consent screen. Existing tokens are TTL-bounded; a
  // consent approval does not retro-upgrade an issued token.
  // Perf: skip the capture probe entirely when the recording provider
  // is disabled (no capture can exist) so the hot join path pays zero
  // extra queries. On probe/consent-read failure with the provider
  // enabled, fail closed to subscribe-only: join stays possible but no
  // new media enters a possibly-captured source before consent.
  let canPublish = true;
  try {
    const { getEnv } = require("../config/env");
    if (getEnv().recordingProvider === "disabled") {
      canPublish = true;
    } else {
      const { hasActiveCapture } = require("./recordingService");
      if (await hasActiveCapture(meetingIdParam)) {
        const RecordingConsent = require("../models/RecordingConsent");
        const consent = await RecordingConsent.findOne(
          {
            meetingId: meeting._id,
            userId,
            noticeVersion: getEnv().recordingNoticeVersion,
            recording: "approved",
          },
          { _id: 1 }
        ).lean();
        if (!consent) {
          canPublish = false;
        }
      }
    }
  } catch (_unused) {
    try {
      const { getEnv: getEnvSafe } = require("../config/env");
      canPublish = getEnvSafe().recordingProvider === "disabled";
    } catch (_ignored) {
      canPublish = false;
    }
  }
  const issued = await mintJoinToken({
    identity: String(userId),
    roomName,
    displayName: profile && typeof profile.name === "string" ? profile.name : "Participant",
    canPublish,
    canPublishData: canPublish,
  });

  return {
    roomName: issued.roomName,
    livekitUrl: issued.livekitUrl,
    token: issued.token,
    permissions: {
      isHost,
      canRecord: isHost || await participantCanRecord(meeting._id, userId),
      canScreenShare: true,
    },
  };
}

async function participantCanRecord(meetingId, userId) {
  if (!userId) return false;
  const row = await MeetingParticipant.findOne({ meetingId, userId, status: "admitted" }, { canRecord: 1 }).lean();
  return Boolean(row?.canRecord);
}

module.exports = { authorizeJoin, roomNameFor };
