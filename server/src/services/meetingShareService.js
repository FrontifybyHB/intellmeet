"use strict";

const crypto = require("node:crypto");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const Meeting = require("../models/Meeting");
const MeetingParticipant = require("../models/MeetingParticipant");
const { authorizeJoin } = require("./meetingJoinService");

// Shareable meeting links (title-only creation flow).
//
// Identity: canonical meetingId stays the authority; the invite code
// is an opaque capability resolved server-side to exactly one meeting,
// and the LiveKit room always derives from the meeting id
// (roomNameFor), never from title/host/client payload. Same title or
// same creator yields distinct meetings with distinct codes/rooms.
//
// Selected admission policy: explicit authenticated-link admission.
// A signed-in user presenting a valid active code for a link-mode
// meeting is admitted as an ORDINARY participant through the same
// admission writer as host approval. Restricted meetings (legacy or
// otherwise), removed/banned users, ended/cancelled/deleted meetings,
// and unknown codes are denied without mutation. Code possession is
// not login and never grants host/admin or artifact access beyond
// ordinary membership (all downstream reads keep their own gates).

const JOIN_CODE_BYTES = 16;
const JOIN_CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const CREATE_COLLISION_RETRIES = 5;

function newJoinCode() {
  return crypto.randomBytes(JOIN_CODE_BYTES).toString("base64url");
}

function validateJoinCode(code) {
  if (typeof code !== "string" || !JOIN_CODE_RE.test(code)) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Invalid invite code.", "INVALID_CODE");
  }
  return code;
}

// Frontend origin for join URLs: the validated configured CLIENT_URL
// (canonical public origin), never Host/Origin request headers.
// Production requires https; local development may use http.
function publicOrigin() {
  const env = getEnv();
  const raw = env.clientUrl || "http://localhost:5173";
  let url;
  try {
    url = new URL(raw);
  } catch (_unused) {
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Share links are not configured.",
      "SHARE_MISCONFIGURED"
    );
  }
  if (env.nodeEnv === "production" && url.protocol !== "https:") {
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Share links are not configured.",
      "SHARE_MISCONFIGURED"
    );
  }
  return url.origin;
}

function joinUrlFor(code) {
  return `${publicOrigin()}/join/${code}`;
}

// Idempotent ordinary-participant admission writer shared by host
// approval and link joins. Never upgrades removed/banned rows and
// never grants host/admin.
async function admitOrdinaryParticipant({ meetingId, userId }) {
  const existing = await MeetingParticipant.findOne(
    { meetingId, userId },
    { status: 1 }
  ).lean();
  if (existing && existing.status === "removed") {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Meeting membership required.",
      "NOT_ADMITTED"
    );
  }
  if (existing && existing.status === "admitted") {
    return { admitted: false, resumed: true };
  }
  try {
    await MeetingParticipant.findOneAndUpdate(
      { meetingId, userId },
      { $set: { status: "admitted" } },
      { upsert: true }
    ).lean();
  } catch (err) {
    if (err && err.code === 11000) {
      return { admitted: false, resumed: true };
    }
    throw err;
  }
  return { admitted: true, resumed: false };
}

// Generate-once code assignment with bounded duplicate-key retry.
// Never overwrites an existing code.
async function assignJoinCode({ meetingId }) {
  for (let attempt = 0; attempt < CREATE_COLLISION_RETRIES; attempt += 1) {
    const code = newJoinCode();
    try {
      const updated = await Meeting.findOneAndUpdate(
        { _id: meetingId, joinCode: null },
        { $set: { joinCode: code } },
        { new: true, projection: { joinCode: 1 } }
      ).lean();
      if (updated && updated.joinCode) {
        return updated.joinCode;
      }
      const current = await Meeting.findById(meetingId, { joinCode: 1 }).lean();
      if (current && current.joinCode) {
        return current.joinCode;
      }
      return code;
    } catch (err) {
      if (err && err.code === 11000) {
        continue;
      }
      throw err;
    }
  }
  throw new AppError(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "Could not issue a share link. Retry shortly.",
    "CODE_COLLISION"
  );
}

// Lazy ensure for link-mode meetings created before codes existed.
// Restricted/legacy meetings get nothing minted.
async function ensureJoinCode(meeting) {
  if (!meeting || meeting.joinCode) {
    return meeting ? meeting.joinCode : null;
  }
  if (meeting.admission !== "link") {
    return null;
  }
  return assignJoinCode({ meetingId: meeting._id });
}

const LINK_LOOKUP_PROJECTION = {
  title: 1,
  hostId: 1,
  status: 1,
  admission: 1,
  joinCode: 1,
};

// Resolve a code to safe metadata. Read-only: never admits, never
// issues tokens, never starts media/sockets/recording.
async function resolveLink({ code, userId }) {
  validateJoinCode(code);
  const meeting = await Meeting.findOne({ joinCode: code }, LINK_LOOKUP_PROJECTION).lean();
  if (!meeting) {
    throw new AppError(HTTP_STATUS.NOT_FOUND, "Invite link is invalid.", "INVALID_CODE");
  }
  let membership = "none";
  if (userId && String(meeting.hostId) === String(userId)) {
    membership = "host";
  } else if (userId) {
    const row = await MeetingParticipant.findOne(
      { meetingId: meeting._id, userId },
      { status: 1 }
    ).lean();
    if (row) {
      membership = row.status;
    }
  }
  return {
    meetingId: String(meeting._id),
    title: meeting.title || null,
    status: meeting.status,
    admission: meeting.admission || "restricted",
    membership,
  };
}

// Explicit Join action: resolve code server-side, enforce lifecycle +
// admission + ban policy, idempotently admit, then mint through the
// existing shared join service (short-lived room-scoped token).
async function joinViaLink({ code, userId }) {
  validateJoinCode(code);
  const meeting = await Meeting.findOne({ joinCode: code }, LINK_LOOKUP_PROJECTION).lean();
  if (!meeting) {
    throw new AppError(HTTP_STATUS.NOT_FOUND, "Invite link is invalid.", "INVALID_CODE");
  }
  if (meeting.status === "ended") {
    throw new AppError(HTTP_STATUS.CONFLICT, "Meeting has ended.", "MEETING_ENDED");
  }
  if (meeting.status === "cancelled") {
    throw new AppError(HTTP_STATUS.FORBIDDEN, "Meeting was cancelled.", "MEETING_CANCELLED");
  }
  if ((meeting.admission || "restricted") !== "link") {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "This meeting does not accept link joins.",
      "LINK_DISABLED"
    );
  }
  const isHost = String(meeting.hostId) === String(userId);
  if (!isHost) {
    await admitOrdinaryParticipant({ meetingId: meeting._id, userId });
  }
  // Re-verify at issuance: end/removal between admission and minting
  // is enforced by the shared join service's live checks; its short
  // TTL bounds any residual provider-token race (documented there).
  const issued = await authorizeJoin({ meetingIdParam: String(meeting._id), userId });
  return {
    meetingId: String(meeting._id),
    title: meeting.title || null,
    ...issued,
  };
}

module.exports = {
  JOIN_CODE_RE,
  newJoinCode,
  validateJoinCode,
  publicOrigin,
  joinUrlFor,
  admitOrdinaryParticipant,
  assignJoinCode,
  ensureJoinCode,
  resolveLink,
  joinViaLink,
};
