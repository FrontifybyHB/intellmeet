"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");

const HISTORY_PAGE_DEFAULT = 20;
const HISTORY_PAGE_MAX = 50;
// Membership scan batch size per indexed query. The history service
// paginates the membership leg (not a hard 1,000-row cap), so the
// full entitled set is preserved regardless of membership count.
const HISTORY_MEETING_FANIN_MAX = 1000;

function badRequest(reason, code) {
  return new AppError(HTTP_STATUS.BAD_REQUEST, reason, code || "VALIDATION_ERROR");
}

function validateHistoryCursor(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !/^[0-9a-fA-F]{24}$/.test(value)) {
    throw badRequest("Invalid cursor.", "VALIDATION_ERROR");
  }
  return value;
}

function validateHistoryLimit(value) {
  if (value === undefined || value === null || value === "") {
    return HISTORY_PAGE_DEFAULT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest("Invalid limit.", "VALIDATION_ERROR");
  }
  return Math.min(parsed, HISTORY_PAGE_MAX);
}

function validateMeetingIdParam(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest("Invalid meeting id.", "INVALID_MEETING_ID");
  }
  return value;
}

module.exports = {
  validateHistoryCursor,
  validateHistoryLimit,
  validateMeetingIdParam,
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  HISTORY_MEETING_FANIN_MAX,
};
