"use strict";

const mongoose = require("mongoose");

// Durable meeting-intelligence run. The document IS the persisted
// intent: restarts reconcile from this collection, so queued work is
// never forgotten across crashes.
//
// - meetingId/recordingId scope the run to existing meeting
//   authorization (no public intelligence, no cross-meeting access).
// - sourceTranscriptRunId/sourceTranscriptRunVersion pin the EXACT
//   published transcript run; a source change starts a NEW run and old
//   segments/outputs are never mixed into it.
// - runId is `ix_<hex>`; runVersion increments per
//   source/model/prompt/schema/context change. version fences every
//   lifecycle transition (conditional findOneAndUpdate on version +
//   runId); terminal states (complete/failed/cancelled/blocked) never
//   regress.
// - Only COMPLETE runs publish: outputs stage on the run, then the
//   run pointer flips atomically (conditional complete transition), so
//   readers never see half-published results.
// - errorCode is a whitelisted safe code only, never provider text.
// - usage counts observed provider calls (map + reduce + retries),
//   never exact token/cost claims.
const evidenceSchema = new mongoose.Schema(
  {
    segmentIds: { type: [String], default: [] },
    startMs: { type: Number, default: null },
    endMs: { type: Number, default: null },
  },
  { _id: false }
);

// One evidence-linked claim ({ text, evidence }). Subdocument _ids
// are disabled: claims are identified by content/evidence, and
// readers compare them structurally (deepEqual in tests, cursors by
// parent run) — surrogate ids would only add noise.
const claimSchema = new mongoose.Schema(
  {
    text: { type: String },
    evidence: { type: evidenceSchema },
  },
  { _id: false }
);

const intelligenceSchema = new mongoose.Schema(
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
    sourceTranscriptRunId: { type: String, required: true },
    sourceTranscriptRunVersion: { type: Number, required: true },
    sourceSegmentCount: { type: Number, default: 0 },
    runId: { type: String, required: true },
    runVersion: { type: Number, required: true },
    version: { type: Number, default: 0 },
    state: { type: String, default: null, index: true },
    pipelineVersion: { type: String, default: null },
    model: { type: String, default: null },
    promptVersion: { type: String, default: null },
    schemaVersion: { type: String, default: null },
    contextVersion: { type: String, default: null },
    consentNoticeVersion: { type: String, default: null },
    // Every published claim — summaries included — carries source
    // evidence (schema s2): a summary without segment IDs is rejected
    // at validation and never published. IDs prove provenance and
    // presence, not semantic support (negation/uncertainty judgment
    // stays a human-review duty); times derive server-side below.
    summaryBullets: { type: [claimSchema], default: [] },
    decisions: { type: [claimSchema], default: [] },
    blockers: { type: [claimSchema], default: [] },
    unresolvedQuestions: { type: [claimSchema], default: [] },
    errorCode: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    workerId: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    enqueuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    externalInFlight: { type: Boolean, default: false },
    usage: {
      providerCalls: { type: Number, default: 0 },
      observedMs: { type: Number, default: 0 },
    },
    updatedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Unique run identity prevents duplicate scheduling; the deterministic
// BullMQ jobId is supplemental — this constraint survives job removal.
intelligenceSchema.index({ recordingId: 1, runVersion: 1 }, { unique: true });
intelligenceSchema.index({ runId: 1 }, { unique: true, sparse: true });
// Actual access paths: per-meeting history sorts, worker/reconciler
// scans on state.
intelligenceSchema.index({ meetingId: 1, createdAt: -1, _id: -1 });
intelligenceSchema.index({ state: 1, enqueuedAt: 1 });
intelligenceSchema.index({ state: 1, updatedAt: 1 });

module.exports =
  mongoose.models.MeetingIntelligence ||
  mongoose.model("MeetingIntelligence", intelligenceSchema);
