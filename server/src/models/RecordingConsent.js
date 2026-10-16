"use strict";

const mongoose = require("mongoose");

// Per-user recording consent. One row per (meeting, user) via the
// unique index — consent history lives HERE as a bounded embedded
// array, never as a growing array on Meeting.
//
// - noticeVersion: the recording notice the decision applies to. A
//   notice bump invalidates prior approvals (fail closed).
// - recording: this user's decision about being captured.
// - aiTransfer: permission to transfer audio to a future AI/Google
//   pipeline. Defaults to "undecided" and is NEVER inferred from the
//   recording decision in either direction.
// - history: withdrawal/change trail (capped length to bound growth).
const CONSENT_HISTORY_MAX = 50;

const consentChangeSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    noticeVersion: { type: String, required: true },
    recording: { type: String, enum: ["approved", "declined"], required: true },
    aiTransfer: {
      type: String,
      enum: ["approved", "declined", "undecided"],
      required: true,
    },
  },
  { _id: false }
);

const recordingConsentSchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Meeting",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    noticeVersion: { type: String, required: true },
    recording: {
      type: String,
      enum: ["approved", "declined"],
      required: true,
    },
    aiTransfer: {
      type: String,
      enum: ["approved", "declined", "undecided"],
      default: "undecided",
    },
    history: { type: [consentChangeSchema], default: [] },
  },
  { timestamps: true }
);

recordingConsentSchema.index({ meetingId: 1, userId: 1 }, { unique: true });
recordingConsentSchema.index({ meetingId: 1, noticeVersion: 1, recording: 1 });

module.exports =
  mongoose.models.RecordingConsent ||
  mongoose.model("RecordingConsent", recordingConsentSchema);
module.exports.CONSENT_HISTORY_MAX = CONSENT_HISTORY_MAX;
