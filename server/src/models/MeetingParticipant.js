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
  },
  { timestamps: true }
);

meetingParticipantSchema.index({ meetingId: 1, userId: 1 }, { unique: true });

module.exports =
  mongoose.models.MeetingParticipant ||
  mongoose.model("MeetingParticipant", meetingParticipantSchema);
