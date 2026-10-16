"use strict";

const mongoose = require("mongoose");

// Reviewable action-item suggestion. Each row belongs to ONE
// intelligence run version with a unique stable suggestion identity,
// so regeneration never resets/rewrites already reviewed items or
// already created tasks.
//
// - Model proposal (titleProposed/detailProposed/proposedOwnerText/
//   proposedDueDateText/evidence) is stored SEPARATELY from reviewed
//   data (title/detail/ownerUserId/dueDateText). Approved text is never
//   overwritten by a model retry.
// - suggestionKey is a stable content identity (hash of normalized
//   title + evidence segment ids) unique per intelligence run.
// - state: proposed | approved | rejected. Task materialization is
//   one Task per approved suggestion via POST
//   /api/meetings/:id/action-items/:itemId/task, idempotent on the
//   stable taskIdempotencyKey. taskLink stays
//   { status: "blocked", reason: "NOT_APPROVED" } until creation, then
//   { status: "created", taskId }.
// - version is the optimistic-concurrency guard for review races
//   (approve/approve, edit/approve, reject/approve, stale approval).
const actionItemSchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Meeting",
      required: true,
    },
    recordingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recording",
      required: true,
    },
    intelligenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MeetingIntelligence",
      required: true,
    },
    intelligenceRunId: { type: String, required: true },
    intelligenceRunVersion: { type: Number, required: true },
    suggestionKey: { type: String, required: true },
    titleProposed: { type: String, required: true, maxlength: 200 },
    detailProposed: { type: String, default: null, maxlength: 1000 },
    proposedOwnerText: { type: String, default: null, maxlength: 120 },
    proposedDueDateText: { type: String, default: null, maxlength: 120 },
    evidenceSegmentIds: { type: [String], default: [] },
    evidenceStartMs: { type: Number, default: null },
    evidenceEndMs: { type: Number, default: null },
    state: {
      type: String,
      enum: ["proposed", "approved", "rejected"],
      default: "proposed",
      index: true,
    },
    version: { type: Number, default: 0 },
    title: { type: String, default: null, maxlength: 200 },
    detail: { type: String, default: null, maxlength: 1000 },
    dueDateText: { type: String, default: null, maxlength: 120 },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    taskLink: {
      status: { type: String, default: "blocked" },
      reason: { type: String, default: "NOT_APPROVED" },
      taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
    },
    // Durable source key for the Task integration: a stable
    // per-suggestion identity the Task call uses as its
    // idempotency key, so timeout/crash replays create exactly one
    // task. Deterministic at suggestion creation; never rewritten by
    // retries or regeneration.
    taskIdempotencyKey: { type: String, default: null },
    history: {
      type: [
        {
          at: { type: Date },
          by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          from: { type: String },
          to: { type: String },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Stable suggestion identity per intelligence version: regeneration
// upserts the same rows, never duplicates or resets reviewed items.
actionItemSchema.index(
  { intelligenceId: 1, suggestionKey: 1 },
  { unique: true }
);
// Future Task-dedupe lookup: one idempotency key per suggestion.
// Partial unique (string values only): key-less rows (explicit null)
// never enter the index, so any number of them coexist; the runner
// always sets a key on creation. Sparse would NOT do: MongoDB indexes
// explicit nulls under sparse, rejecting the second key-less row.
actionItemSchema.index(
  { taskIdempotencyKey: 1 },
  { unique: true, partialFilterExpression: { taskIdempotencyKey: { $type: "string" } } }
);
// Cursor/list access paths (limit+1 cursors on _id).
actionItemSchema.index({ meetingId: 1, state: 1, _id: 1 });
actionItemSchema.index({ meetingId: 1, _id: 1 });

module.exports =
  mongoose.models.ActionItem || mongoose.model("ActionItem", actionItemSchema);
