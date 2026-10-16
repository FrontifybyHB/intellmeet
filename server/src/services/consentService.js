"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const Meeting = require("../models/Meeting");
const MeetingParticipant = require("../models/MeetingParticipant");
const RecordingConsent = require("../models/RecordingConsent");
const { CONSENT_HISTORY_MAX } = require("../models/RecordingConsent");
const { authorizeMeetingAccess } = require("./meetingAccessService");
const { isRecorderIdentity } = require("../constants/recordingLimits");

function currentNoticeVersion() {
  return getEnv().recordingNoticeVersion;
}

// Fail-closed consent gate for capture.
//
// Policy: every human whose media may be captured must affirm the
// CURRENT recording notice before capture starts. The required set is
// the host plus all status === "admitted" participants, resolved live
// from the membership collection on every check (never cached).
// - Unknown presence/consent blocks start: missing, declined, or
//   stale-notice rows all throw CONSENT_BLOCKED.
// - Service recorder identities are positively identified by server
//   prefix and never counted as humans — membership is NOT inferred
//   from socket subscriptions, issued tokens, or client flags.
// - AI-transfer permission is stored separately and never inferred
//   from the recording decision.
//
// LIMITATION (reported, not silenced): without the LiveKit
// RoomService client in this repo (no livekit-server-sdk installed),
// live media presence cannot be distinguished from admitted
// membership, so the gate runs on admission state plus token-level
// publish restrictions for late joins. Outstanding tokens stay usable
// until their short TTL expires.
async function requiredHumans(meeting) {
  const rows = await MeetingParticipant.find(
    { meetingId: meeting.meetingId, status: "admitted" },
    { userId: 1 }
  ).lean();
  const ids = [String(meeting.hostUserId)];
  for (const row of rows) {
    const id = String(row.userId);
    if (id !== String(meeting.hostUserId) && !isRecorderIdentity(id)) {
      ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

async function assertRecordingConsent({ meetingIdParam, userId }) {
  // The caller (host starting capture) is admission-checked here, and
  // terminal meetings are rejected inside authorizeMeetingAccess.
  const { meetingId } = await authorizeMeetingAccess({
    meetingIdParam,
    userId,
  });
  const meeting = await Meeting.findById(meetingId, { hostId: 1 }).lean();
  if (!meeting) {
    throw new AppError(
      HTTP_STATUS.NOT_FOUND,
      "Meeting not found.",
      "MEETING_NOT_FOUND"
    );
  }
  const humans = await requiredHumans({
    meetingId: meeting._id,
    hostUserId: meeting.hostId,
  });
  const noticeVersion = currentNoticeVersion();
  const approvals = await RecordingConsent.find(
    {
      meetingId: meeting._id,
      userId: { $in: humans },
      noticeVersion,
      recording: "approved",
    },
    { userId: 1 }
  ).lean();
  const approvedSet = new Set(approvals.map((row) => String(row.userId)));
  const missing = humans.filter((id) => !approvedSet.has(String(id)));
  if (missing.length > 0) {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Recording consent is incomplete for the current notice.",
      "CONSENT_BLOCKED"
    );
  }
  return {
    meetingId: meeting._id,
    noticeVersion,
    approvedCount: approvedSet.size,
    requiredCount: humans.length,
  };
}

// Participants change only their OWN row; userId always comes from
// verified auth. Consent persists BEFORE any status broadcast — the
// controller emits only after this resolves.
async function setConsent({ meetingIdParam, userId, decision, aiTransfer, noticeVersion }) {
  await authorizeMeetingAccess({ meetingIdParam, userId });
  const now = new Date();
  const change = {
    at: now,
    noticeVersion,
    recording: decision,
    aiTransfer,
  };
  const doc = await RecordingConsent.findOneAndUpdate(
    { meetingId: meetingIdParam, userId },
    {
      $set: { noticeVersion, recording: decision, aiTransfer },
      $push: { history: { $each: [change], $slice: -CONSENT_HISTORY_MAX } },
    },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  return serializeConsent(doc);
}

async function getOwnConsent({ meetingIdParam, userId }) {
  await authorizeMeetingAccess({ meetingIdParam, userId });
  const doc = await RecordingConsent.findOne(
    { meetingId: meetingIdParam, userId },
    { meetingId: 1, userId: 1, noticeVersion: 1, recording: 1, aiTransfer: 1, updatedAt: 1 }
  ).lean();
  return {
    noticeVersion: currentNoticeVersion(),
    consent: doc ? serializeConsent(doc) : null,
  };
}

function serializeConsent(doc) {
  return {
    meetingId: String(doc.meetingId),
    userId: String(doc.userId),
    noticeVersion: doc.noticeVersion,
    recording: doc.recording,
    aiTransfer: doc.aiTransfer,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

module.exports = {
  currentNoticeVersion,
  assertRecordingConsent,
  setConsent,
  getOwnConsent,
  serializeConsent,
};
