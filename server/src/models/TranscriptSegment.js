"use strict";

const mongoose = require("mongoose");

// Immutable transcript segment. One row per (recording run, chunk,
// ordinal): the unique index makes worker writes idempotent, so
// replays and retries never duplicate text.
//
// - meetingId/recordingId scope reads to existing meeting/recording
//   authorization (no public transcript, no cross-meeting access).
// - runId/runVersion bind the segment to one validated pipeline run;
//   a source/model/prompt change starts a NEW run and old rows are
//   never mixed into it. Readers see only the published run unless a
//   partial view is explicitly requested and labeled.
// - chunkIndex + offsetMs anchor the segment on the original meeting
//   timeline; startMs/endMs are integer milliseconds, end >= start.
// - speakerLabel is a provisional diarization hint ("speaker_1"),
//   NEVER a User mapping. Timestamps/speakers are model estimates.
// - text is plain transcribed speech (untrusted data, rendered as
//   text); no tasks, summaries, emotions, or instructions are stored.
const transcriptSegmentSchema = new mongoose.Schema(
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
    runId: { type: String, required: true },
    runVersion: { type: Number, required: true },
    chunkIndex: { type: Number, required: true, min: 0 },
    ordinal: { type: Number, required: true, min: 0 },
    offsetMs: { type: Number, required: true, min: 0 },
    startMs: { type: Number, required: true, min: 0 },
    endMs: { type: Number, required: true, min: 0 },
    text: { type: String, required: true, maxlength: 2000 },
    language: { type: String, default: null },
    speakerLabel: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Idempotent write identity: replaying a chunk upserts the same rows.
transcriptSegmentSchema.index(
  { recordingId: 1, runId: 1, chunkIndex: 1, ordinal: 1 },
  { unique: true }
);

// Cursor pagination reuses the unique index prefix (recordingId,
// runId, chunkIndex, ordinal); meetingId+recordingId+runId covers the
// per-meeting read path.
transcriptSegmentSchema.index({ meetingId: 1, recordingId: 1, runId: 1 });

module.exports =
  mongoose.models.TranscriptSegment ||
  mongoose.model("TranscriptSegment", transcriptSegmentSchema);
