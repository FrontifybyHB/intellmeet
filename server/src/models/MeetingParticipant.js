"use strict";

const mongoose = require("mongoose");

// Server-verified membership used only for authorization.
// Only status === "admitted" may join. The unique (meetingId, userId)
// index guarantees one membership row per user per meeting.
const meetingParticipantSchema = new mongoose.Schema(
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
    status: {
      type: String,
      enum: ["invited", "admitted", "removed"],
      default: "invited",
      index: true,
    },
    // Recording is an explicit meeting-scoped capability. It is never
    // inferred from application role or client state.
    canRecord: { type: Boolean, default: false },
  },
  { timestamps: true }
);

meetingParticipantSchema.index({ meetingId: 1, userId: 1 }, { unique: true });
// Reverse leg for entitled meeting history (meetings where the user is
// an admitted participant): userId-first lookup, then bounded $in on
// Meeting._id. Without this, history would scan by meeting.
meetingParticipantSchema.index({ userId: 1, meetingId: 1 });
// Paginated entitlement scan (newest-first _id cursor): supports users
// with more than one batch of memberships without silent truncation.
meetingParticipantSchema.index({ userId: 1, status: 1, _id: -1 });

module.exports =
  mongoose.models.MeetingParticipant ||
  mongoose.model("MeetingParticipant", meetingParticipantSchema);
