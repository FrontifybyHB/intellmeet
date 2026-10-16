"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const {
  CONSENT_DECISIONS,
  TRANSFER_DECISIONS,
  RECORDING_LIMITS,
} = require("../constants/recordingLimits");

function badRequest(reason, code) {
  return new AppError(HTTP_STATUS.BAD_REQUEST, reason, code);
}

function validateMeetingIdParam(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest("Invalid meeting id.", "INVALID_MEETING_ID");
  }
  return value;
}

function validateRecordingIdParam(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest("Invalid recording id.", "INVALID_RECORDING_ID");
  }
  return value;
}

// Consent payload: participants may change only their OWN row (the
// service binds userId from auth). noticeVersion must echo the current
// server notice; stale versions are rejected, never silently accepted.
function validateConsentBody(body, currentNoticeVersion) {
  const input = body && typeof body === "object" ? body : {};
  if (
    input.decision !== CONSENT_DECISIONS.APPROVED &&
    input.decision !== CONSENT_DECISIONS.DECLINED
  ) {
    throw badRequest("decision must be approved or declined.", "VALIDATION_ERROR");
  }
  if (typeof input.noticeVersion !== "string" || input.noticeVersion.length === 0) {
    throw badRequest("noticeVersion is required.", "VALIDATION_ERROR");
  }
  if (input.noticeVersion !== currentNoticeVersion) {
    throw new AppError(
      HTTP_STATUS.CONFLICT,
      "The recording notice changed. Review the current notice and decide again.",
      "NOTICE_VERSION_MISMATCH"
    );
  }
  let aiTransfer = TRANSFER_DECISIONS.UNDECIDED;
  if (input.aiTransfer !== undefined && input.aiTransfer !== null) {
    if (
      input.aiTransfer !== TRANSFER_DECISIONS.APPROVED &&
      input.aiTransfer !== TRANSFER_DECISIONS.DECLINED &&
      input.aiTransfer !== TRANSFER_DECISIONS.UNDECIDED
    ) {
      throw badRequest(
        "aiTransfer must be approved, declined or undecided.",
        "VALIDATION_ERROR"
      );
    }
    aiTransfer = input.aiTransfer;
  }
  return { decision: input.decision, aiTransfer };
}

function validateStorageLocator(bucket, key, prefix) {
  if (typeof bucket !== "string" || bucket.length === 0 || bucket.length > 128) {
    return false;
  }
  if (typeof key !== "string" || key.length === 0) {
    return false;
  }
  if (key.length > RECORDING_LIMITS.STORAGE_KEY_MAX) {
    return false;
  }
  // SSRF/path-traversal guard: keys must stay under the configured
  // private prefix, use a safe charset, and never look like a URL.
  if (prefix && key.indexOf(prefix) !== 0) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(key)) {
    return false;
  }
  if (key.indexOf("..") !== -1) {
    return false;
  }
  if (!/^[A-Za-z0-9/_.\-]+$/.test(key)) {
    return false;
  }
  return true;
}

module.exports = {
  validateMeetingIdParam,
  validateRecordingIdParam,
  validateConsentBody,
  validateStorageLocator,
};
