"use strict";

const mongoose = require("mongoose");

// Minimal Meeting contract for join authorization.
// Host access is resolved server-side from hostId; callers must never
// supply a role. No joinCount / presence fields: issuing a join token
// must not mutate attendance.
const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true },
    hostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["scheduled", "live", "ended", "cancelled"],
      default: "scheduled",
      index: true,
    },
    scheduledAt: { type: Date },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Meeting || mongoose.model("Meeting", meetingSchema);
