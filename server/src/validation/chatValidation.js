"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { resolveChatLimits } = require("../constants/chatLimits");

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function badRequest(reason, code) {
  return new AppError(HTTP_STATUS.BAD_REQUEST, reason, code);
}

function invalid(reason) {
  return badRequest(reason, "VALIDATION_ERROR");
}

// clientMessageId is an opaque client-generated uuid (uuid v4 fits:
// 36 chars from the allowed alphabet). Strict charset keeps the unique
// index well-behaved; the DB constraint remains the dedup authority.
function validateClientMessageId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid("clientMessageId is required.");
  }
  if (
    value.length > resolveChatLimits().CLIENT_MESSAGE_ID_MAX ||
    !CLIENT_MESSAGE_ID_PATTERN.test(value)
  ) {
    throw invalid("clientMessageId is invalid.");
  }
  return value;
}

// Bounded plain text. Stored verbatim (no HTML interpretation anywhere);
// blank-only messages are rejected. Both a character bound and a UTF-8
// byte bound apply.
function validateText(value) {
  if (typeof value !== "string") {
    throw invalid("text is required.");
  }
  if (value.includes("\0")) {
    throw invalid("text is invalid.");
  }
  const chars = Array.from(value);
  const limits = resolveChatLimits();
  if (
    chars.length === 0 ||
    chars.length > limits.MESSAGE_MAX_CHARS ||
    value.trim().length === 0
  ) {
    throw invalid("text is invalid.");
  }
  if (Buffer.byteLength(value, "utf8") > limits.MESSAGE_MAX_BYTES) {
    throw invalid("text is invalid.");
  }
  return value;
}

function validateMeetingIdParam(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest("Invalid meeting id.", "INVALID_MEETING_ID");
  }
  return value;
}

function validateLimit(raw) {
  const limits = resolveChatLimits();
  if (raw === undefined || raw === null || raw === "") {
    return limits.PAGE_DEFAULT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw badRequest("Invalid limit.", "INVALID_LIMIT");
  }
  return Math.min(value, limits.PAGE_MAX);
}

function validateDirection(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return "older";
  }
  if (raw === "older" || raw === "newer") {
    return raw;
  }
  throw badRequest("Invalid direction.", "INVALID_DIRECTION");
}

// Opaque cursor over the stable (createdAt, _id) ordering:
// base64url(JSON { c: ISO timestamp, id: 24-hex }). Cursors never carry
// the meeting id; every query binds the authorized meeting filter, so a
// cursor minted in one room cannot read another room.
function encodeCursor(createdAt, id) {
  const payload = {
    c: new Date(createdAt).toISOString(),
    id: String(id),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    throw badRequest("Invalid cursor.", "INVALID_CURSOR");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch (_unused) {
    throw badRequest("Invalid cursor.", "INVALID_CURSOR");
  }
  if (!parsed || typeof parsed !== "object") {
    throw badRequest("Invalid cursor.", "INVALID_CURSOR");
  }
  const time = new Date(parsed.c).getTime();
  if (!Number.isFinite(time)) {
    throw badRequest("Invalid cursor.", "INVALID_CURSOR");
  }
  if (
    typeof parsed.id !== "string" ||
    !/^[a-fA-F0-9]{24}$/.test(parsed.id)
  ) {
    throw badRequest("Invalid cursor.", "INVALID_CURSOR");
  }
  return { createdAt: new Date(time), id: new mongoose.Types.ObjectId(parsed.id) };
}

module.exports = {
  validateClientMessageId,
  validateText,
  validateMeetingIdParam,
  validateLimit,
  validateDirection,
  encodeCursor,
  decodeCursor,
};
