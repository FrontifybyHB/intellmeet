"use strict";

const mongoose = require("mongoose");

// Durable chat storage. One row per (meeting, sender, clientMessageId):
// the compound unique index is the deduplication authority — not a
// check-then-insert or a process Map — so simultaneous duplicate sends
// collapse to a single row via duplicate-key handling in chatService.
// Rows are append-only: no update path exists, timestamps are
// server-assigned, and sender/text come only from validated input.
const chatMessageSchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Meeting",
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    clientMessageId: {
      type: String,
      required: true,
    },
    text: {
      type: String,
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Deduplication authority: one message per client id per sender per meeting.
chatMessageSchema.index(
  { meetingId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true }
);

// History pagination order: stable (createdAt, _id) in both directions.
chatMessageSchema.index({ meetingId: 1, createdAt: 1, _id: 1 });

module.exports =
  mongoose.models.ChatMessage || mongoose.model("ChatMessage", chatMessageSchema);
