"use strict";

const mongoose = require("mongoose");

const { HTTP_STATUS } = require("../constants/httpStatus");
const AppError = require("../utils/AppError");
const asyncHandler = require("../utils/asyncHandler");
const Meeting = require("../models/Meeting");
const MeetingParticipant = require("../models/MeetingParticipant");
const User = require("../models/User");
const { newJoinCode, joinUrlFor } = require("../services/meetingShareService");

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

// Title-only shareable creation. The creator/host always derives from
// the authenticated cookie identity (req.user.id); owner/host/room/
// code/policy/admin fields in the body are ignored, never trusted.
// New meetings are link-admission mode with a freshly minted opaque
// joinCode (CSPRNG, bounded collision retry); the joinUrl derives from
// the configured public frontend origin, never request headers.
const CREATE_COLLISION_RETRIES = 5;
const createMeetingHandler = asyncHandler(async (req, res) => {
  const rawTitle = req.body && req.body.title;
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0 || rawTitle.trim().length > 200) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Invalid title.", "VALIDATION_ERROR");
  }
  const title = rawTitle.trim();
  let meeting = null;
  let lastError = null;
  for (let attempt = 0; attempt < CREATE_COLLISION_RETRIES; attempt += 1) {
    try {
      meeting = await Meeting.create({
        title,
        hostId: req.user.id,
        status: "live",
        admission: "link",
        joinCode: newJoinCode(),
      });
      lastError = null;
      break;
    } catch (err) {
      if (err && err.code === 11000) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  if (!meeting) {
    throw (
      lastError ||
      new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, "Could not create the meeting.", "DB_ERROR")
    );
  }
  noStore(res);
  res.status(HTTP_STATUS.CREATED).json({
    id: String(meeting._id),
    meetingId: String(meeting._id),
    title: meeting.title,
    status: meeting.status,
    hostId: String(meeting.hostId),
    joinCode: meeting.joinCode,
    joinUrl: joinUrlFor(meeting.joinCode),
  });
});

const admitMemberHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Invalid meeting id.", "INVALID_MEETING_ID");
  }
  const rawUserId = req.body && req.body.userId;
  if (typeof rawUserId !== "string" || !mongoose.Types.ObjectId.isValid(rawUserId)) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Invalid user id.", "VALIDATION_ERROR");
  }
  const meeting = await Meeting.findById(id, { hostId: 1, status: 1 }).lean();
  if (!meeting) {
    throw new AppError(HTTP_STATUS.NOT_FOUND, "Meeting not found.", "MEETING_NOT_FOUND");
  }
  if (String(meeting.hostId) !== String(req.user.id)) {
    throw new AppError(HTTP_STATUS.FORBIDDEN, "Only the host can admit members.", "NOT_HOST");
  }
  if (meeting.status === "ended" || meeting.status === "cancelled") {
    throw new AppError(HTTP_STATUS.CONFLICT, "Meeting is closed.", "MEETING_ENDED");
  }
  const user = await User.findById(rawUserId, { status: 1 }).lean();
  if (!user || user.status !== "active") {
    throw new AppError(HTTP_STATUS.NOT_FOUND, "User not found.", "USER_NOT_FOUND");
  }
  await MeetingParticipant.findOneAndUpdate(
    { meetingId: meeting._id, userId: user._id },
    { $set: { status: "admitted" } },
    { upsert: true }
  ).lean();
  noStore(res);
  res.status(HTTP_STATUS.OK).json({ meetingId: String(meeting._id), userId: String(user._id), status: "admitted" });
});

module.exports = { createMeetingHandler, admitMemberHandler };
