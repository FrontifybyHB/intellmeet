"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const Meeting = require("../models/Meeting");
const RecordingConsent = require("../models/RecordingConsent");
const { isRecorderIdentity } = require("../constants/recordingLimits");

// Google transfer/transcription consent gate.
//
// Policy (fail closed): every captured human must hold
// aiTransfer === "approved" at the CURRENT notice version. The
// checked set is the union of:
// - the live required set (host + status === "admitted" participants),
//   each of whom must hold an approving row, and
// - every historical consent row for the meeting: a removed
//   participant's later decline/withdrawal still blocks, because mixed
//   room audio cannot reliably redact one speaker.
// Recording-only approval ("recording") is INSUFFICIENT on its own.
// Service recorder identities (server prefix) are never humans.
// Membership is re-read live on every check — never cached.
//
// The gate runs at enqueue, before external upload/call, and before
// commit/publish (the worker re-checks; a withdrawal racing the run
// blocks publication even if bytes already left).
async function requiredTransferHumans(meetingId, hostUserId) {
  const MeetingParticipant = require("../models/MeetingParticipant");
  const rows = await MeetingParticipant.find(
    { meetingId, status: "admitted" },
    { userId: 1 }
  ).lean();
  const ids = [String(hostUserId)];
  for (const row of rows) {
    const id = String(row.userId);
    if (id !== String(hostUserId) && !isRecorderIdentity(id)) {
      ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

async function assertTransferConsent({ meetingId }) {
  const meeting = await Meeting.findById(meetingId, { hostId: 1 }).lean();
  if (!meeting) {
    throw new AppError(
      HTTP_STATUS.NOT_FOUND,
      "Meeting not found.",
      "MEETING_NOT_FOUND"
    );
  }
  const noticeVersion = getEnv().recordingNoticeVersion;
  const humans = await requiredTransferHumans(meeting._id, meeting.hostId);
  const rows = await RecordingConsent.find(
    { meetingId: meeting._id },
    { userId: 1, noticeVersion: 1, recording: 1, aiTransfer: 1 }
  ).lean();
  const byUser = new Map(rows.map((row) => [String(row.userId), row]));
  // Historical coverage: every known row must approve transfer at the
  // current notice; stale or declined rows block.
  for (const row of rows) {
    if (isRecorderIdentity(String(row.userId))) {
      continue;
    }
    if (
      row.noticeVersion !== noticeVersion ||
      row.recording !== "approved" ||
      row.aiTransfer !== "approved"
    ) {
      throw new AppError(
        HTTP_STATUS.FORBIDDEN,
        "Google transfer consent is incomplete for the current notice.",
        "CONSENT_BLOCKED"
      );
    }
  }
  // Live coverage: every currently required human holds a row.
  for (const id of humans) {
    const row = byUser.get(String(id));
    if (
      !row ||
      row.noticeVersion !== noticeVersion ||
      row.recording !== "approved" ||
      row.aiTransfer !== "approved"
    ) {
      const err = new AppError(
        HTTP_STATUS.FORBIDDEN,
        "Google transfer consent is incomplete for the current notice.",
        "CONSENT_BLOCKED"
      );
      err.transferMissing = true;
      throw err;
    }
  }
  return {
    meetingId: meeting._id,
    noticeVersion,
    approvedCount: humans.length,
    requiredCount: humans.length,
  };
}

module.exports = { assertTransferConsent, requiredTransferHumans };
