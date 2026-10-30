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
    // The instant remains UTC in scheduledAt; this preserves the intended
    // local zone for display after creation.
    timezone: { type: String, default: null, maxlength: 100 },
    // Shareable invite identity (task: shareable meeting URLs).
    // joinCode is an opaque CSPRNG capability (16 bytes base64url,
    // >=128 random bits) — never a title slug, timestamp, or
    // sequential id. Codes are generated once at creation (or lazily
    // ensured for link-mode meetings) and never reassigned, including
    // after end/deletion. Legacy meetings without a code predate this
    // feature and resolve as restricted (no code minted for them).
    joinCode: { type: String, default: null },
    // Admission policy for invite links. "link": a signed-in user
    // presenting a valid active code is admitted as an ordinary
    // participant via the existing admission writer. "restricted":
    // host approval / workspace rules apply; a code (if any) grants
    // nothing. Legacy meetings without this field are restricted.
    admission: {
      type: String,
      enum: ["link", "restricted"],
      default: "restricted",
    },
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

// Host leg for entitled meeting history (meetings the user hosts).
// Without this, the host side of the history $or would scan.
meetingSchema.index({ hostId: 1, _id: -1 });
// Invite-code leg: exact lookup by opaque code only. Partial unique so
// legacy meetings without a code are unaffected (no backfill rewrite,
// no disruptive index build on existing data); populated codes are
// globally unique and never reassigned.
meetingSchema.index(
  { joinCode: 1 },
  { unique: true, partialFilterExpression: { joinCode: { $type: "string" } } }
);

module.exports =
  mongoose.models.Meeting || mongoose.model("Meeting", meetingSchema);
