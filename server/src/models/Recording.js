"use strict";

const mongoose = require("mongoose");

const { NONTERMINAL_STATES } = require("../constants/recordingLimits");

// Durable recording attempt. The document IS the persisted intent:
// restarts reconcile from this collection, so provider work is never
// forgotten across crashes.
//
// - meetingId/sessionId scope one capture attempt. sessionId is the
//   LiveKit room name (meeting_<id>); the partial unique index below
//   enforces at most one NONTERMINAL attempt per meeting/session at
//   the DB level (partial indexes require MongoDB 3.2+; the Phase 2
//   suite already runs against modern MongoDB).
// - providerEgressId: server-persisted provider correlation. Sparse
//   unique: set once, never trusted from client/webhook input alone.
// - version: optimistic-concurrency guard. Every lifecycle transition
//   is findOneAndUpdate({ _id, version }) + $inc, so stale/reordered
//   callbacks cannot regress a terminal state.
// - consentSnapshot: notice version + approver count captured at start.
//   Review metadata only — authorization always re-reads live consent.
// - storage: server-selected bucket/key/format. No blobs, no
//   credentials, no permanent public URLs, no stored signed links.
// - errorCode: whitelisted safe code only, never provider text.
// - recoveryLeaseUntil/recoveryAttempts: bounded leased recovery for
//   ambiguous start/stop/end and missed terminal callbacks.
const recordingSchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Meeting",
      required: true,
    },
    sessionId: { type: String, required: true },
    providerEgressId: { type: String, default: null },
    state: {
      type: String,
      enum: [
        "requested",
        "starting",
        "active",
        "stopping",
        "verifying",
        "ready",
        "failed",
        "aborted",
        "unknown",
      ],
      default: "requested",
      index: true,
    },
    version: { type: Number, default: 0 },
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    consentSnapshot: {
      noticeVersion: { type: String },
      approvedCount: { type: Number },
      requiredCount: { type: Number },
      capturedAt: { type: Date },
    },
    storage: {
      bucket: { type: String },
      key: { type: String },
      format: { type: String },
    },
    output: {
      durationMs: { type: Number },
      sizeBytes: { type: Number },
    },
    errorCode: { type: String, default: null },
    consentRevoked: { type: Boolean, default: false },
    providerUpdatedAt: { type: Date, default: null },
    recoveryLeaseUntil: { type: Date, default: null },
    recoveryAttempts: { type: Number, default: 0 },
    // Phase 4 transcription run. The subdocument IS the durable run
    // identity — no duplicate generic job model. runId is
    // `tr_<ObjectId>`; runVersion increments per source/model/prompt
    // change so stale chunks never mix. version fences every
    // lifecycle transition (conditional findOneAndUpdate on
    // transcription.version + transcription.runId); terminal states
    // (complete/failed/cancelled/blocked) never regress.
    // - source: immutable snapshot of the transcribed bytes
    //   (bucket/key/format/bytes/durationMs) — a changed source starts
    //   a new run, never reuses old segments.
    // - chunks: bounded manifest (<= TRANSCRIPT_MAX_CHUNKS) with per
    //   chunk offset/duration/state/attempts for checkpoint resume.
    // - publishedRunVersion: readers see only segments of the complete
    //   published run; partial output stays staged under the run.
    // - externalInFlight/remoteCleanupRequested record the documented
    //   race: bytes already sent to Google cannot be unsent; cancel
    //   suppresses publication and requests cleanup best-effort.
    transcription: {
      state: { type: String, default: null },
      runId: { type: String, default: null },
      runVersion: { type: Number, default: 0 },
      version: { type: Number, default: 0 },
      pipelineVersion: { type: String, default: null },
      model: { type: String, default: null },
      promptVersion: { type: String, default: null },
      schemaVersion: { type: String, default: null },
      source: {
        bucket: { type: String },
        key: { type: String },
        format: { type: String },
        bytes: { type: Number },
        durationMs: { type: Number },
        audioHash: { type: String },
      },
      chunks: [
        {
          index: { type: Number },
          offsetMs: { type: Number },
          durationMs: { type: Number },
          state: { type: String },
          attempts: { type: Number, default: 0 },
          _id: false,
        },
      ],
      publishedRunVersion: { type: Number, default: null },
      publishedAt: { type: Date, default: null },
      segmentCount: { type: Number, default: 0 },
      errorCode: { type: String, default: null },
      leaseUntil: { type: Date, default: null },
      workerId: { type: String, default: null },
      attempts: { type: Number, default: 0 },
      enqueuedAt: { type: Date, default: null },
      startedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      externalInFlight: { type: Boolean, default: false },
      remoteCleanupRequested: { type: Boolean, default: false },
      providerFileName: { type: String, default: null },
      updatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// DB-enforced single nonterminal attempt per meeting/session.
recordingSchema.index(
  { meetingId: 1, sessionId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: NONTERMINAL_STATES } },
  }
);

// Actual access paths: provider reconciliation, meeting history,
// recovery scans, active-budget checks.
recordingSchema.index(
  { providerEgressId: 1 },
  {
    unique: true,
    // Partial (not sparse): multiple attempts with no egress id yet
    // (null across different meetings, e.g. concurrent starts) must
    // coexist; uniqueness applies once a string id is assigned. The
    // start race is still fenced by the partial (meetingId, sessionId)
    // index above, which fires independently of this one.
    partialFilterExpression: { providerEgressId: { $type: "string" } },
  }
);
recordingSchema.index({ meetingId: 1, createdAt: 1, _id: 1 });
recordingSchema.index({ state: 1, updatedAt: 1 });
recordingSchema.index({ state: 1, recoveryLeaseUntil: 1 });
// Phase 4 transcription access paths: enqueue reconciler scan and
// worker fencing reads. Both bounded and selective.
recordingSchema.index({ "transcription.state": 1, "transcription.enqueuedAt": 1 });
recordingSchema.index({ "transcription.state": 1, updatedAt: 1 });

module.exports =
  mongoose.models.Recording || mongoose.model("Recording", recordingSchema);
