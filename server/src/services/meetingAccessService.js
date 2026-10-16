"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const Meeting = require("../models/Meeting");
const MeetingParticipant = require("../models/MeetingParticipant");

// Shared meeting authorization for Phase 2 chat paths (history HTTP +
// socket room join/send). Same state contract as Phase 1 join:
// 400 malformed id, 404 missing meeting, 403 ended/cancelled, 403 unless
// host or admitted participant. Identity always comes from verified
// server auth — never from client claims.
//
// Authoritative indexed reads on every call: chat authorization is never
// cached, so removal/end take effect on the next join, send, or history
// page. Both reads project only the fields needed and use lean() (these
// schemas have no getters, virtuals, or document middleware).
async function authorizeMeetingAccess({ meetingIdParam, userId }) {
  if (
    typeof meetingIdParam !== "string" ||
    !mongoose.Types.ObjectId.isValid(meetingIdParam)
  ) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid meeting id.",
      "INVALID_MEETING_ID"
    );
  }

  const meeting = await Meeting.findById(meetingIdParam, {
    hostId: 1,
    status: 1,
  }).lean();
  if (!meeting) {
    throw new AppError(
      HTTP_STATUS.NOT_FOUND,
      "Meeting not found.",
      "MEETING_NOT_FOUND"
    );
  }
  if (meeting.status === "ended") {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Meeting has ended.",
      "MEETING_ENDED"
    );
  }
  if (meeting.status === "cancelled") {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Meeting was cancelled.",
      "MEETING_CANCELLED"
    );
  }

  const isHost = String(meeting.hostId) === String(userId);
  if (!isHost) {
    const membership = await MeetingParticipant.findOne(
      { meetingId: meeting._id, userId },
      { status: 1 }
    ).lean();
    if (!membership) {
      throw new AppError(
        HTTP_STATUS.FORBIDDEN,
        "Meeting membership required.",
        "NOT_A_MEMBER"
      );
    }
    if (membership.status !== "admitted") {
      throw new AppError(
        HTTP_STATUS.FORBIDDEN,
        "Meeting membership required.",
        "NOT_ADMITTED"
      );
    }
  }

  return { meetingId: meeting._id, isHost };
}

module.exports = { authorizeMeetingAccess };
