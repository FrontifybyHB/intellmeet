"use strict";

const mongoose = require("mongoose");

// Minimal meeting Task contract owned by this module. One Task per
// approved ActionItem, keyed idempotently by the suggestion's stable
// taskIdempotencyKey so timeout/crash replays and duplicate
// approval/create requests create exactly one Task.
//
// - meetingId/actionItemId/intelligenceId pin provenance; actionItemId
//   is unique (one task per suggestion).
// - idempotencyKey is globally unique when present (sparse) and is the
//   creation boundary: Task.create with a duplicate key returns the
//   existing row instead of forking.
// - title/detail/ownerUserId/dueDateText snapshot the reviewed values
//   at creation time; later review edits do not rewrite a created task.
const taskSchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Meeting",
      required: true,
      index: true,
    },
    actionItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ActionItem",
      required: true,
      unique: true,
    },
    intelligenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MeetingIntelligence",
      required: true,
    },
    recordingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recording",
      required: true,
    },
    title: { type: String, required: true, maxlength: 200 },
    detail: { type: String, default: null, maxlength: 1000 },
    dueDateText: { type: String, default: null, maxlength: 120 },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: { type: String, default: "open", index: true },
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

taskSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
taskSchema.index({ meetingId: 1, _id: 1 });

module.exports = mongoose.models.Task || mongoose.model("Task", taskSchema);
