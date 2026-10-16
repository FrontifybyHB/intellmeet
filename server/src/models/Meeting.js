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
    // Phase 3 termination facts. endedAt marks admission closure;
    // mediaCleanup is a SEPARATE fact (provider room teardown), and
    // closeVersion guards conditional end writes against races.
    // No arrays grow here: consent history lives on RecordingConsent.
    endedAt: { type: Date, default: null },
    closeVersion: { type: Number, default: 0 },
    mediaCleanup: {
      state: {
        type: String,
        enum: ["none", "pending", "done", "unknown"],
        default: "none",
      },
      at: { type: Date, default: null },
      errorCode: { type: String, default: null },
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Meeting || mongoose.model("Meeting", meetingSchema);
