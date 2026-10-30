"use strict";

const { getEnv } = require("../config/env");
const RecordingConsent = require("../models/RecordingConsent");
const { CONSENT_HISTORY_MAX } = require("../models/RecordingConsent");
const { authorizeMeetingAccess } = require("./meetingAccessService");

function currentNoticeVersion() {
  return getEnv().recordingNoticeVersion;
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
  setConsent,
  getOwnConsent,
  serializeConsent,
};
