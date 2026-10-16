"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const Meeting = require("../models/Meeting");
const MeetingParticipant = require("../models/MeetingParticipant");
const Recording = require("../models/Recording");
const MeetingIntelligence = require("../models/MeetingIntelligence");
const ActionItem = require("../models/ActionItem");
const {
  validateHistoryCursor,
  validateHistoryLimit,
  validateMeetingIdParam,
} = require("../validation/meetingHistoryValidation");

// Post-meeting read integration. Reuses landed Phase 3/4/5 status
// shapes by pointer only — never duplicates their endpoints, never
// embeds blobs (segments, bullets, evidence, chat), never populates
// profiles (no N+1 user lookups per row).
//
// Access: every call re-reads live membership (host or admitted
// participant). Ended meetings remain readable under the same
// membership; removed/outsider ids see 403/404 with no content leak.
// There is no team retention policy in this repo: nothing is
// auto-deleted here, and reads do not depend on one (marked DEFERRED
// in the Phase 6 matrix). Reads never enqueue work or create tasks.

const HISTORY_PROJECTION = {
  title: 1,
  hostId: 1,
  status: 1,
  scheduledAt: 1,
  endedAt: 1,
};

const RECORDING_POINTER_PROJECTION = {
  meetingId: 1,
  state: 1,
  version: 1,
  transcription: 1,
  createdAt: 1,
};

const INTELLIGENCE_POINTER_PROJECTION = {
  meetingId: 1,
  recordingId: 1,
  runVersion: 1,
  state: 1,
  errorCode: 1,
  sourceTranscriptRunVersion: 1,
  sourceSegmentCount: 1,
  publishedAt: 1,
};

function summarizeMeeting(row, userId) {
  return {
    id: String(row._id),
    title: row.title || null,
    status: row.status,
    isHost: String(row.hostId) === String(userId),
    scheduledAt: row.scheduledAt ? new Date(row.scheduledAt).toISOString() : null,
    endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
  };
}

// Entitled meeting history: hosted OR currently admitted. Cursor is
// the last seen _id (newest-first); the cursor binds the same
// entitled filter, so pages never escape authorization. limit+1
// probing, no skip, no total counts.
//
// Membership leg: paginated in _id-ordered batches so users with more
// than HISTORY_MEETING_FANIN_MAX memberships still reach their oldest
// entitled meetings (no silent 1,000-row truncation). Batches reuse
// the { userId, status, _id } index; the batch size stays bounded per
// query while the union preserves the full entitled set.
const MEMBERSHIP_BATCH = 1000;
async function collectAdmittedMeetingIds(userId) {
  const mongoose = require("mongoose");
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const ids = [];
  let lastId = null;
  for (;;) {
    const query = { userId: userObjectId, status: "admitted" };
    if (lastId) {
      query._id = { $lt: lastId };
    }
    const batch = await MeetingParticipant.find(query, { meetingId: 1 })
      .sort({ _id: -1 })
      .limit(MEMBERSHIP_BATCH)
      .lean();
    for (const row of batch) {
      ids.push(row.meetingId);
    }
    if (batch.length < MEMBERSHIP_BATCH) {
      break;
    }
    lastId = batch[batch.length - 1]._id;
  }
  return ids;
}
async function listMeetings({ userId, cursor, limit }) {
  const mongoose = require("mongoose");
  if (typeof userId !== "string" || !mongoose.Types.ObjectId.isValid(userId)) {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Authentication required.", "UNAUTHORIZED");
  }
  const after = validateHistoryCursor(cursor);
  const pageSize = validateHistoryLimit(limit);
  const admittedIds = await collectAdmittedMeetingIds(userId);
  const filter = { $or: [{ hostId: userId }, { _id: { $in: admittedIds } }] };
  if (after) {
    filter._id = { $lt: new mongoose.Types.ObjectId(after) };
  }
  const rows = await Meeting.find(filter, HISTORY_PROJECTION)
    .sort({ _id: -1 })
    .limit(pageSize + 1)
    .lean();
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page.length > 0 ? page[page.length - 1] : null;
  return {
    meetings: page.map((row) => summarizeMeeting(row, userId)),
    hasMore,
    nextCursor: last ? String(last._id) : null,
  };
}

async function authorizeHistoryRead({ meetingIdParam, userId }) {
  validateMeetingIdParam(meetingIdParam);
  const meeting = await Meeting.findById(meetingIdParam, {
    hostId: 1,
    title: 1,
    status: 1,
    scheduledAt: 1,
    endedAt: 1,
    admission: 1,
    joinCode: 1,
  }).lean();
  if (!meeting) {
    throw new AppError(HTTP_STATUS.NOT_FOUND, "Meeting not found.", "MEETING_NOT_FOUND");
  }
  const isHost = String(meeting.hostId) === String(userId);
  if (!isHost) {
    const membership = await MeetingParticipant.findOne(
      { meetingId: meeting._id, userId },
      { status: 1 }
    ).lean();
    if (!membership || membership.status !== "admitted") {
      throw new AppError(
        HTTP_STATUS.FORBIDDEN,
        "Meeting membership required.",
        membership ? "NOT_ADMITTED" : "NOT_A_MEMBER"
      );
    }
  }
  return { meeting, isHost };
}

// Meeting detail: summary + versioned status pointers. Large content
// (chat pages, transcript segments, intelligence output, suggestions)
// loads separately through the existing bounded endpoints; this
// response carries ids/states/versions only, so a list of details
// never becomes an N+1 blob fetch.
async function getMeetingDetail({ meetingIdParam, userId }) {
  const { meeting, isHost } = await authorizeHistoryRead({ meetingIdParam, userId });
  // Share link reuse: link-mode meetings expose the same stable
  // joinUrl minted at creation (lazily ensured for pre-code link-mode
  // rows); restricted/legacy meetings expose none.
  let joinUrl = null;
  try {
    const { ensureJoinCode, joinUrlFor } = require("./meetingShareService");
    const code = await ensureJoinCode(meeting);
    if (code) {
      joinUrl = joinUrlFor(code);
    }
  } catch (_unused) {
    joinUrl = null;
  }
  const latestRecording = await Recording.findOne(
    { meetingId: meeting._id },
    RECORDING_POINTER_PROJECTION
  )
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  let transcription = null;
  if (latestRecording && latestRecording.transcription && latestRecording.transcription.runId) {
    const tx = latestRecording.transcription;
    transcription = {
      recordingId: String(latestRecording._id),
      state: tx.state || null,
      runVersion: tx.runVersion === undefined ? null : tx.runVersion,
      publishedRunVersion: tx.publishedRunVersion === undefined ? null : tx.publishedRunVersion,
      segmentCount: typeof tx.segmentCount === "number" ? tx.segmentCount : 0,
      errorCode: tx.errorCode || null,
    };
  }
  let intelligence = null;
  let suggestions = { proposed: 0, approved: 0, rejected: 0 };
  if (latestRecording) {
    const latest = await MeetingIntelligence.findOne(
      { meetingId: meeting._id, recordingId: latestRecording._id },
      INTELLIGENCE_POINTER_PROJECTION
    )
      .sort({ runVersion: -1 })
      .lean();
    if (latest) {
      intelligence = {
        intelligenceId: String(latest._id),
        recordingId: String(latest.recordingId),
        state: latest.state,
        runVersion: latest.runVersion,
        errorCode: latest.errorCode || null,
        sourceTranscriptRunVersion:
          latest.sourceTranscriptRunVersion === undefined ? null : latest.sourceTranscriptRunVersion,
        publishedAt: latest.publishedAt ? new Date(latest.publishedAt).toISOString() : null,
      };
      const counts = await ActionItem.aggregate([
        { $match: { intelligenceId: latest._id } },
        { $group: { _id: "$state", count: { $sum: 1 } } },
      ]);
      for (const row of counts) {
        if (suggestions[row._id] !== undefined) {
          suggestions[row._id] = row.count;
        }
      }
    }
  }
  // Recording pointer distinguishes pending/blocked/retrying/failed/
  // cancelled/complete-equivalent (ready) states; partial or
  // uncertain-consent output is never presented as ready output.
  return {
    meeting: {
      id: String(meeting._id),
      title: meeting.title || null,
      status: meeting.status,
      isHost,
      scheduledAt: meeting.scheduledAt ? new Date(meeting.scheduledAt).toISOString() : null,
      endedAt: meeting.endedAt ? new Date(meeting.endedAt).toISOString() : null,
      joinUrl,
    },
    recording: latestRecording
      ? {
          recordingId: String(latestRecording._id),
          state: latestRecording.state,
          version: latestRecording.version,
        }
      : null,
    transcription,
    intelligence,
    suggestions,
  };
}

module.exports = { listMeetings, getMeetingDetail, authorizeHistoryRead };
