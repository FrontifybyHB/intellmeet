"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { TRANSCRIPTION_LIMITS } = require("../constants/transcriptionLimits");

function badRequest(reason, code) {
  return new AppError(HTTP_STATUS.BAD_REQUEST, reason, code);
}

function validateRecordingIdParam(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest("Invalid recording id.", "INVALID_RECORDING_ID");
  }
  return value;
}

// Cursor for transcript pagination: "<chunkIndex>:<ordinal>" of the
// last seen segment; "" / undefined starts from the beginning.
function validateTranscriptCursor(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.length > 32) {
    throw badRequest("Invalid cursor.", "VALIDATION_ERROR");
  }
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) {
    throw badRequest("Invalid cursor.", "VALIDATION_ERROR");
  }
  const chunkIndex = Number(match[1]);
  const ordinal = Number(match[2]);
  if (!Number.isInteger(chunkIndex) || !Number.isInteger(ordinal)) {
    throw badRequest("Invalid cursor.", "VALIDATION_ERROR");
  }
  return { chunkIndex, ordinal };
}

function validateTranscriptLimit(value) {
  if (value === undefined || value === null || value === "") {
    return TRANSCRIPTION_LIMITS.TRANSCRIPT_PAGE_DEFAULT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest("Invalid limit.", "VALIDATION_ERROR");
  }
  return Math.min(parsed, TRANSCRIPTION_LIMITS.TRANSCRIPT_PAGE_MAX);
}

const SEGMENT_TEXT_MAX = 2000;
const SPEAKER_LABEL_MAX = 32;
const LANGUAGE_MAX = 16;

// Independent runtime validation of one provider segment. JSON shape
// alone proves nothing: finite nonnegative times, end >= start,
// source-duration bounds, bounded text, strict unknown-field rejection
// (passthrough of model-invented fields is forbidden).
function validateProviderSegment(raw, { chunkOffsetMs, chunkDurationMs, sourceDurationMs }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Segment must be an object.");
  }
  const allowed = new Set(["startMs", "endMs", "text", "language", "speakerLabel"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown segment field: ${key}.`);
    }
  }
  const { startMs, endMs, text, language, speakerLabel } = raw;
  if (!Number.isFinite(startMs) || startMs < 0) {
    throw new Error("Segment startMs must be a finite nonnegative number.");
  }
  if (!Number.isFinite(endMs) || endMs < 0) {
    throw new Error("Segment endMs must be a finite nonnegative number.");
  }
  const start = Math.round(startMs);
  const end = Math.round(endMs);
  if (end < start) {
    throw new Error("Segment endMs must be >= startMs.");
  }
  // Times are relative to the chunk; allow the documented overlap
  // tolerance on both edges, then normalize to the meeting timeline.
  const tolerance = 5000;
  if (start > chunkDurationMs + tolerance || end > chunkDurationMs + tolerance) {
    throw new Error("Segment exceeds chunk duration.");
  }
  if (typeof text !== "string" || text.length === 0 || text.length > SEGMENT_TEXT_MAX) {
    throw new Error("Segment text must be 1-2000 chars.");
  }
  // Plain-text only: reject control characters (no formatting tricks,
  // no embedded instructions smuggling).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new Error("Segment text contains control characters.");
  }
  if (language !== undefined && language !== null) {
    if (typeof language !== "string" || language.length === 0 || language.length > LANGUAGE_MAX) {
      throw new Error("Invalid segment language.");
    }
  }
  if (speakerLabel !== undefined && speakerLabel !== null) {
    if (
      typeof speakerLabel !== "string" ||
      speakerLabel.length === 0 ||
      speakerLabel.length > SPEAKER_LABEL_MAX ||
      !/^speaker_[0-9]{1,3}$/.test(speakerLabel)
    ) {
      throw new Error("Invalid segment speakerLabel.");
    }
  }
  const absoluteStart = chunkOffsetMs + start;
  const absoluteEnd = chunkOffsetMs + end;
  if (
    Number.isFinite(sourceDurationMs) &&
    (absoluteStart > sourceDurationMs + tolerance || absoluteEnd > sourceDurationMs + tolerance)
  ) {
    throw new Error("Segment exceeds source duration.");
  }
  return {
    startMs: absoluteStart,
    endMs: absoluteEnd,
    text,
    language: language || null,
    speakerLabel: speakerLabel || null,
  };
}

function validateProviderPayload(payload, context) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("Malformed provider output.");
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  if (!Array.isArray(payload.segments)) {
    const err = new Error("Provider output has no segments array.");
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  if (payload.segments.length > TRANSCRIPTION_LIMITS.MAX_SEGMENTS_PER_CHUNK_DEFAULT) {
    const err = new Error("Provider returned too many segments.");
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  return payload.segments.map((raw) => validateProviderSegment(raw, context));
}

module.exports = {
  validateRecordingIdParam,
  validateTranscriptCursor,
  validateTranscriptLimit,
  validateProviderSegment,
  validateProviderPayload,
  SEGMENT_TEXT_MAX,
};
