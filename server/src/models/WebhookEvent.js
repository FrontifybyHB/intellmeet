"use strict";

const mongoose = require("mongoose");

// Durable webhook idempotence record. The unique eventId index is the
// duplicate/replay authority: concurrent or redelivered provider
// callbacks collapse to one processed event. Unknown or mismatched
// room/session/provider ids are recorded as rejected so replays of
// bad payloads stay cheap and auditable.
const webhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    event: { type: String, required: true },
    roomName: { type: String, default: null },
    providerEgressId: { type: String, default: null },
    recordingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recording",
      default: null,
    },
    outcome: {
      type: String,
      enum: ["applied", "duplicate", "rejected", "ignored"],
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

webhookEventSchema.index({ providerEgressId: 1, createdAt: 1 });

module.exports =
  mongoose.models.WebhookEvent ||
  mongoose.model("WebhookEvent", webhookEventSchema);
