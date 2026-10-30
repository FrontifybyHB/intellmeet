"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const Meeting = require("../models/Meeting");
const Recording = require("../models/Recording");
const { roomNameFor } = require("./meetingJoinService");
const { authorizeMeetingAccess } = require("./meetingAccessService");
const provider = require("./recordingProvider");
const { validateStorageLocator } = require("../validation/recordingValidation");
const {
  RECORDING_STATES,
  NONTERMINAL_STATES,
  RECORDING_ERROR_CODES,
  mapProviderStatus,
} = require("../constants/recordingLimits");
const { publishToMeeting } = require("../sockets/realtime");
const recordingMetrics = require("../utils/recordingMetrics");

const LIST_PROJECTION = {
  meetingId: 1,
  sessionId: 1,
  providerEgressId: 1,
  state: 1,
  version: 1,
  requesterId: 1,
  consentSnapshot: 1,
  storage: 1,
  output: 1,
  errorCode: 1,
  providerUpdatedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 100;

function serializeRecording(doc) {
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(plain._id),
    meetingId: String(plain.meetingId),
    sessionId: plain.sessionId,
    providerEgressId: plain.providerEgressId || null,
    state: plain.state,
    version: plain.version,
    requesterId: plain.requesterId ? String(plain.requesterId) : null,
    consentSnapshot: plain.consentSnapshot || null,
    storage: plain.storage || null,
    output: plain.output || null,
    errorCode: plain.errorCode || null,
    providerUpdatedAt: plain.providerUpdatedAt
      ? new Date(plain.providerUpdatedAt).toISOString()
      : null,
    createdAt: plain.createdAt ? new Date(plain.createdAt).toISOString() : null,
    updatedAt: plain.updatedAt ? new Date(plain.updatedAt).toISOString() : null,
  };
}

function safeErrorCode(code) {
  if (typeof code === "string" && RECORDING_ERROR_CODES.has(code)) {
    return code;
  }
  return "DB_ERROR";
}

function withTimeout(promise, ms, onTimeoutCode) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Provider operation timed out.");
      err.code = onTimeoutCode;
      reject(err);
    }, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

// Conditional version-checked transition. Returns the updated doc, or
// null when the version/state precondition failed (stale callback —
// the stored state wins, terminal states never regress).
async function transitionAttempt(recordingId, expectedVersion, fromStates, toState, patch) {
  const update = {
    $set: { ...(patch || {}), state: toState },
    $inc: { version: 1 },
  };
  const filter = { _id: recordingId, version: expectedVersion };
  if (Array.isArray(fromStates)) {
    filter.state = { $in: fromStates };
  } else if (typeof fromStates === "string") {
    filter.state = fromStates;
  }
  return Recording.findOneAndUpdate(filter, update, { new: true }).lean();
}

function emitStatus(meetingIdParam, recording) {
  publishToMeeting(roomNameFor(meetingIdParam), "recording:status", {
    meetingId: meetingIdParam,
    recording: serializeRecording(recording),
  });
  if (recording.state === RECORDING_STATES.READY) {
    publishToMeeting(roomNameFor(meetingIdParam), "recording:ready", {
      meetingId: meetingIdParam,
      recordingId: recording._id ? String(recording._id) : recording.id,
      state: RECORDING_STATES.READY,
    });
  }
}

async function requireRecorder({ meetingIdParam, userId }) {
  const { meetingId, isHost } = await authorizeMeetingAccess({
    meetingIdParam,
    userId,
  });
  if (!isHost) {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      "Only the host can control recording.",
      "NOT_HOST",
    );
  }
  return meetingId;
}

async function findScopedRecording({ meetingId, recordingIdParam }) {
  const { validateRecordingIdParam } = require("../validation/recordingValidation");
  validateRecordingIdParam(recordingIdParam);
  const doc = await Recording.findOne(
    { _id: recordingIdParam, meetingId },
    LIST_PROJECTION
  ).lean();
  if (!doc) {
    // Covers unknown ids AND cross-meeting ids: never confirm whether
    // the id exists in another meeting.
    throw new AppError(
      HTTP_STATUS.NOT_FOUND,
      "Recording not found.",
      "RECORDING_NOT_FOUND"
    );
  }
  return doc;
}

async function findNonterminalAttempt(meetingId, sessionId) {
  return Recording.findOne(
    { meetingId, sessionId, state: { $in: NONTERMINAL_STATES } },
    LIST_PROJECTION
  ).lean();
}

// --- Start --------------------------------------------------------------
// Concurrent starts yield ONE durable attempt: the insert relies on the
// partial unique (meetingId, sessionId) index, so the loser reads the
// winner instead of creating a second provider session.
async function startRecording({ meetingIdParam, userId }) {
  const meetingId = await requireRecorder({ meetingIdParam, userId });
  const sessionId = roomNameFor(meetingId);
  const env = getEnv();

  const existing = await findNonterminalAttempt(meetingId, sessionId);
  if (existing) {
    return { recording: serializeRecording(existing), resumed: true };
  }

  const activeCount = await Recording.countDocuments({
    state: { $in: NONTERMINAL_STATES },
  });
  if (activeCount >= env.recordingMaxActiveGlobal) {
    recordingMetrics.observeReject("OVERLOADED");
    throw new AppError(
      HTTP_STATUS.TOO_MANY_REQUESTS,
      "Too many active recordings. Retry shortly.",
      "OVERLOADED"
    );
  }

  if (!env.recordingOutputBucket) {
    recordingMetrics.observeReject("INTEGRATION_BLOCKER");
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Recording storage is not configured.",
      "INTEGRATION_BLOCKER"
    );
  }

  let attempt;
  try {
    attempt = await Recording.create({
      meetingId,
      sessionId,
      requesterId: userId,
      state: RECORDING_STATES.REQUESTED,
      version: 0,
      consentSnapshot: {
        noticeVersion: env.recordingNoticeVersion,
        capturedAt: new Date(),
      },
    });
  } catch (err) {
    if (err && (err.code === 11000 || err.code === "11000")) {
      // Lost the start race: return the winner's durable attempt.
      const winner = await findNonterminalAttempt(meetingId, sessionId);
      if (winner) {
        return { recording: serializeRecording(winner), resumed: true };
      }
    }
    recordingMetrics.observeReject("DB_ERROR");
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Could not start recording.",
      "DB_ERROR"
    );
  }

  const attemptId = attempt._id;
  const key = `${env.recordingKeyPrefix}${String(meetingId)}/${sessionId}/${String(attemptId)}.${env.recordingOutputFormat}`;
  if (!validateStorageLocator(env.recordingOutputBucket, key, env.recordingKeyPrefix)) {
    await transitionAttempt(attemptId, 0, RECORDING_STATES.REQUESTED, RECORDING_STATES.FAILED, {
      errorCode: "OUTPUT_INVALID",
    });
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Could not start recording.",
      "DB_ERROR"
    );
  }

  const starting = await transitionAttempt(
    attemptId,
    0,
    RECORDING_STATES.REQUESTED,
    RECORDING_STATES.STARTING,
    {
      storage: {
        bucket: env.recordingOutputBucket,
        key,
        format: env.recordingOutputFormat,
      },
    }
  );
  if (!starting) {
    // End/stop won the race before we left requested: surface the
    // current durable state instead of calling the provider.
    const current = await Recording.findById(attemptId, LIST_PROJECTION).lean();
    return { recording: serializeRecording(current), resumed: true };
  }

  recordingMetrics.observeStart();
  // Re-verify liveness after the consent gate: an end/close that raced
  // the gate must not produce provider work. The check-then-call
  // sequence is still not atomic (provider + DB cannot be atomic),
  // but the late-stop compensation below + recovery bound the orphan
  // window to the provider RPC duration.
  const live = await Meeting.findById(meetingId, { status: 1 }).lean();
  if (!live || live.status === "ended" || live.status === "cancelled") {
    await transitionAttempt(
      attemptId,
      starting.version,
      RECORDING_STATES.STARTING,
      RECORDING_STATES.ABORTED,
      { errorCode: "MEETING_ENDED" }
    );
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      live && live.status === "cancelled" ? "Meeting was cancelled." : "Meeting has ended.",
      live && live.status === "cancelled" ? "MEETING_CANCELLED" : "MEETING_ENDED"
    );
  }
  const providerStarted = process.hrtime.bigint();
  let started;
  try {
    started = await withTimeout(
      provider.startRoomCompositeEgress({
        roomName: sessionId,
        bucket: env.recordingOutputBucket,
        key,
        format: env.recordingOutputFormat,
      }),
      env.recordingProviderTimeoutMs,
      "PROVIDER_TIMEOUT_UNKNOWN"
    );
    recordingMetrics.observeProviderLatency(
      Number(process.hrtime.bigint() - providerStarted) / 1e6
    );
  } catch (err) {
    recordingMetrics.observeProviderLatency(
      Number(process.hrtime.bigint() - providerStarted) / 1e6
    );
    if (err && err.code === "PROVIDER_TIMEOUT_UNKNOWN") {
      // UNKNOWN, not failed: the provider may still create the Egress.
      // Lease for recovery; reconcile before any retry (retries first
      // read the attempt and resume it — never assume idempotency keys
      // the provider may not support).
      const unknown = await transitionAttempt(
        attemptId,
        starting.version,
        RECORDING_STATES.STARTING,
        RECORDING_STATES.UNKNOWN,
        {
          errorCode: "PROVIDER_TIMEOUT_UNKNOWN",
          recoveryLeaseUntil: new Date(Date.now() + env.recordingRecoveryLeaseMs),
        }
      );
      recordingMetrics.observeError();
      const errOut = new AppError(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "Recording start timed out and is being reconciled. Retry shortly.",
        "PROVIDER_TIMEOUT_UNKNOWN"
      );
      errOut.recording = serializeRecording(
        unknown || (await Recording.findById(attemptId, LIST_PROJECTION).lean())
      );
      throw errOut;
    }
    if (err && err.code === "INTEGRATION_BLOCKER") {
      await transitionAttempt(
        attemptId,
        starting.version,
        RECORDING_STATES.STARTING,
        RECORDING_STATES.FAILED,
        { errorCode: "INTEGRATION_BLOCKER" }
      );
      recordingMetrics.observeReject("INTEGRATION_BLOCKER");
      throw err;
    }
    await transitionAttempt(
      attemptId,
      starting.version,
      RECORDING_STATES.STARTING,
      RECORDING_STATES.FAILED,
      { errorCode: "PROVIDER_START_FAILED" }
    );
    recordingMetrics.observeError();
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Could not start recording.",
      "PROVIDER_START_FAILED"
    );
  }

  // Persist the provider correlation BEFORE announcing active: a crash
  // between provider creation and this write is recovered by session
  // matching (webhook before save) or the unknown-state lease.
  const withEgress = await transitionAttempt(
    attemptId,
    starting.version,
    RECORDING_STATES.STARTING,
    RECORDING_STATES.STARTING,
    { providerEgressId: started.egressId, providerUpdatedAt: new Date() }
  );
  const current = withEgress ||
    (await Recording.findById(attemptId, LIST_PROJECTION).lean());
  // Late stop/end may have moved the attempt to stopping while the
  // provider call was in flight: compensate by stopping the unintended
  // Egress instead of orphaning a recorder.
  if (current && current.state === RECORDING_STATES.STOPPING && started.egressId) {
    try {
      await provider.stopEgress({ egressId: started.egressId });
    } catch (stopErr) {
      logger.error("recording_compensating_stop_failed", {
        recordingId: String(attemptId),
      });
    }
  }
  emitStatus(meetingIdParam, current);
  return { recording: serializeRecording(current), resumed: false };
}

// --- Stop ---------------------------------------------------------------
// Idempotent: stopping an already-terminal attempt returns it (a
// stopped attempt can never be resurrected by a delayed callback).
async function stopRecording({ meetingIdParam, recordingIdParam, userId }) {
  const meetingId = await requireRecorder({ meetingIdParam, userId });
  const doc = await findScopedRecording({ meetingId, recordingIdParam });

  if (
    doc.state === RECORDING_STATES.READY ||
    doc.state === RECORDING_STATES.FAILED ||
    doc.state === RECORDING_STATES.ABORTED
  ) {
    return { recording: serializeRecording(doc), resumed: true };
  }
  if (
    doc.state === RECORDING_STATES.STOPPING ||
    doc.state === RECORDING_STATES.VERIFYING
  ) {
    return { recording: serializeRecording(doc), resumed: true };
  }

  const stopping = await transitionAttempt(
    doc._id,
    doc.version,
    [RECORDING_STATES.REQUESTED, RECORDING_STATES.STARTING, RECORDING_STATES.ACTIVE, RECORDING_STATES.UNKNOWN],
    RECORDING_STATES.STOPPING,
    {}
  );
  const current = stopping ||
    (await Recording.findById(doc._id, LIST_PROJECTION).lean());
  if (!stopping) {
    return { recording: serializeRecording(current), resumed: true };
  }

  recordingMetrics.observeStop();
  if (current.providerEgressId) {
    try {
      await withTimeout(
        provider.stopEgress({ egressId: current.providerEgressId }),
        getEnv().recordingProviderTimeoutMs,
        "PROVIDER_TIMEOUT_UNKNOWN"
      );
    } catch (err) {
      // Provider stop failure must not lose the intent: the attempt
      // stays stopping with a recovery lease; terminal callbacks and
      // recovery finish the job.
      logger.error("recording_provider_stop_failed", {
        recordingId: String(doc._id),
      });
      await Recording.findOneAndUpdate(
        { _id: doc._id },
        {
          $set: {
            errorCode: "PROVIDER_STOP_FAILED",
            recoveryLeaseUntil: new Date(
              Date.now() + getEnv().recordingRecoveryLeaseMs
            ),
          },
        }
      ).lean();
    }
  }
  const refreshed = await Recording.findById(doc._id, LIST_PROJECTION).lean();
  emitStatus(meetingIdParam, refreshed || current);
  return { recording: serializeRecording(refreshed || current), resumed: false };
}

// --- Provider event application (webhooks + recovery) ---------------------
async function applyProviderEvent({ recordingId, providerStatus, outputMeta }) {
  const doc = await Recording.findById(recordingId, LIST_PROJECTION).lean();
  if (!doc) {
    return null;
  }
  const mapped = mapProviderStatus(providerStatus);
  if (!mapped) {
    return serializeRecording(doc);
  }
  if (
    doc.state === RECORDING_STATES.READY ||
    doc.state === RECORDING_STATES.FAILED ||
    doc.state === RECORDING_STATES.ABORTED
  ) {
    // Terminal: stale callbacks never regress.
    return serializeRecording(doc);
  }

  // Quarantined output (consent withdrawn or meeting ended mid-verify)
  // finalizes as aborted, never ready.
  if (doc.consentRevoked && (mapped === "verifying" || mapped === "failed" || mapped === "aborted")) {
    const aborted = await transitionAttempt(
      doc._id,
      doc.version,
      NONTERMINAL_STATES,
      RECORDING_STATES.ABORTED,
      { errorCode: doc.errorCode || "CONSENT_WITHDRAWN", providerUpdatedAt: new Date() }
    );
    return serializeRecording(
      aborted || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }

  if (mapped === "starting" || mapped === "active") {
    if (doc.state === RECORDING_STATES.STOPPING) {
      // Late successful start while stopping: stop the unintended Egress.
      if (doc.providerEgressId) {
        try {
          await provider.stopEgress({ egressId: doc.providerEgressId });
        } catch (_unused) {
          // Recovery lease already covers this path.
        }
      }
      return serializeRecording(doc);
    }
    const moved = await transitionAttempt(
      doc._id,
      doc.version,
      [RECORDING_STATES.REQUESTED, RECORDING_STATES.STARTING, RECORDING_STATES.UNKNOWN, RECORDING_STATES.ACTIVE],
      mapped === "active" ? RECORDING_STATES.ACTIVE : RECORDING_STATES.STARTING,
      {
        ...(outputMeta && outputMeta.egressId && !doc.providerEgressId
          ? { providerEgressId: outputMeta.egressId }
          : {}),
        providerUpdatedAt: new Date(),
      }
    );
    return serializeRecording(
      moved || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }

  if (mapped === "stopping") {
    const moved = await transitionAttempt(
      doc._id,
      doc.version,
      [RECORDING_STATES.REQUESTED, RECORDING_STATES.STARTING, RECORDING_STATES.ACTIVE, RECORDING_STATES.UNKNOWN],
      RECORDING_STATES.STOPPING,
      { providerUpdatedAt: new Date() }
    );
    return serializeRecording(
      moved || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }

  if (mapped === "failed" || mapped === "aborted") {
    const toState =
      mapped === "failed" ? RECORDING_STATES.FAILED : RECORDING_STATES.ABORTED;
    const moved = await transitionAttempt(doc._id, doc.version, NONTERMINAL_STATES, toState, {
      errorCode:
        providerStatus === "EGRESS_LIMIT_REACHED"
          ? "PROVIDER_LIMIT_REACHED"
          : mapped === "failed"
            ? "PROVIDER_FAILED"
            : "PROVIDER_ABORTED",
      providerUpdatedAt: new Date(),
    });
    return serializeRecording(
      moved || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }

  // mapped === "verifying" (EGRESS_COMPLETE): ready ONLY after the
  // expected private output exists via the configured storage API.
  const verifying = await transitionAttempt(
    doc._id,
    doc.version,
    NONTERMINAL_STATES,
    RECORDING_STATES.VERIFYING,
    { providerUpdatedAt: new Date() }
  );
  const current = verifying ||
    (await Recording.findById(doc._id, LIST_PROJECTION).lean());
  return finalizeVerifiedOutput(current);
}

async function finalizeVerifiedOutput(doc) {
  if (!doc || doc.state !== RECORDING_STATES.VERIFYING) {
    return doc ? serializeRecording(doc) : null;
  }
  if (doc.consentRevoked) {
    const aborted = await transitionAttempt(
      doc._id,
      doc.version,
      RECORDING_STATES.VERIFYING,
      RECORDING_STATES.ABORTED,
      { errorCode: doc.errorCode || "CONSENT_WITHDRAWN" }
    );
    return serializeRecording(
      aborted || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }
  const bucket = doc.storage && doc.storage.bucket;
  const key = doc.storage && doc.storage.key;
  if (!validateStorageLocator(bucket, key, getEnv().recordingKeyPrefix)) {
    const failed = await transitionAttempt(
      doc._id,
      doc.version,
      RECORDING_STATES.VERIFYING,
      RECORDING_STATES.FAILED,
      { errorCode: "OUTPUT_INVALID" }
    );
    return serializeRecording(
      failed || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }
  let meta = null;
  try {
    meta = await provider.verifyStoredOutput({
      bucket,
      key,
      providerEgressId: doc.providerEgressId,
    });
  } catch (err) {
    const errorCode = err && err.code === "OUTPUT_MISSING"
      ? "OUTPUT_MISSING"
      : "STORAGE_VERIFY_FAILED";
    const failed = await transitionAttempt(
      doc._id,
      doc.version,
      RECORDING_STATES.VERIFYING,
      RECORDING_STATES.FAILED,
      { errorCode }
    );
    return serializeRecording(
      failed || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }
  if (!meta) {
    const failed = await transitionAttempt(
      doc._id,
      doc.version,
      RECORDING_STATES.VERIFYING,
      RECORDING_STATES.FAILED,
      { errorCode: "OUTPUT_MISSING" }
    );
    return serializeRecording(
      failed || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
    );
  }
  const ready = await transitionAttempt(
    doc._id,
    doc.version,
    RECORDING_STATES.VERIFYING,
    RECORDING_STATES.READY,
    {
      output: {
        durationMs: Number.isFinite(meta.durationMs) ? meta.durationMs : null,
        sizeBytes: Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : null,
      },
      errorCode: null,
    }
  );
  const published = serializeRecording(
    ready || (await Recording.findById(doc._id, LIST_PROJECTION).lean())
  );
  // Phase 4: durable auto-enqueue intent for eligible recordings
  // (ended meeting + ready + transfer consent). Non-blocking for the
  // webhook ack: intent persistence + the reconciler make it durable.
  if (published && published.state === RECORDING_STATES.READY) {
    try {
      const { maybeAutoEnqueue } = require("./transcriptionService");
      maybeAutoEnqueue({ meetingId: doc.meetingId, recordingId: doc._id }).catch(
        () => {}
      );
    } catch (_unused) {
      // Auto-enqueue is best-effort here; the reconciler covers gaps.
    }
  }
  return published;
}

// --- Reads -----------------------------------------------------------------
// Recording status/history stays readable AFTER the meeting ends so
// evicted clients can recover missed recording:status/ready events
// through a bounded authorized fetch. Membership is still verified
// live on every call (removal still denies); only the terminal-state
// denial is lifted for reads. Writes (start/stop/consent) keep the
// strict denial via authorizeMeetingAccess.
async function authorizeRecordingRead({ meetingIdParam, userId }) {
  const mongoose = require("mongoose");
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
  const isHost = String(meeting.hostId) === String(userId);
  if (!isHost) {
    const MeetingParticipant = require("../models/MeetingParticipant");
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
  return { meetingId: meeting._id, isHost };
}

async function listRecordings({ meetingIdParam, userId, limit }) {
  const { meetingId } = await authorizeRecordingRead({ meetingIdParam, userId });
  let pageSize = LIST_LIMIT_DEFAULT;
  if (limit !== undefined && limit !== null && limit !== "") {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new AppError(HTTP_STATUS.BAD_REQUEST, "Invalid limit.", "VALIDATION_ERROR");
    }
    pageSize = Math.min(parsed, LIST_LIMIT_MAX);
  }
  const rows = await Recording.find({ meetingId }, LIST_PROJECTION)
    .sort({ createdAt: -1, _id: -1 })
    .limit(pageSize + 1)
    .lean();
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  return { recordings: page.map(serializeRecording), hasMore };
}

async function getRecording({ meetingIdParam, recordingIdParam, userId }) {
  const { meetingId } = await authorizeRecordingRead({ meetingIdParam, userId });
  const doc = await findScopedRecording({ meetingId, recordingIdParam });
  return serializeRecording(doc);
}

// Short-lived access link, minted only after fresh authorization and
// only for ready recordings. Links are never stored or logged, and
// post-issuance revocation is not assumed.
async function accessLink({ meetingIdParam, recordingIdParam, userId }) {
  const { meetingId } = await authorizeRecordingRead({ meetingIdParam, userId });
  const doc = await findScopedRecording({ meetingId, recordingIdParam });
  if (doc.state !== RECORDING_STATES.READY) {
    throw new AppError(
      HTTP_STATUS.CONFLICT,
      "Recording is not ready.",
      "RECORDING_NOT_FOUND"
    );
  }
  const env = getEnv();
  if (!env.recordingStorageConfigured) {
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Recording access is not configured.",
      "INTEGRATION_BLOCKER"
    );
  }
  if (
    !validateStorageLocator(
      doc.storage && doc.storage.bucket,
      doc.storage && doc.storage.key,
      env.recordingKeyPrefix
    )
  ) {
    throw new AppError(
      HTTP_STATUS.CONFLICT,
      "Recording output is unavailable.",
      "OUTPUT_INVALID"
    );
  }
  const exp = Math.floor(Date.now() / 1000) + env.recordingAccessLinkTtlSeconds;
  let url;
  try {
    url = await provider.getPrivateObjectUrl({
      bucket: doc.storage.bucket,
      key: doc.storage.key,
    });
  } catch (_unused) {
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Recording access is temporarily unavailable.",
      "STORAGE_UNAVAILABLE"
    );
  }
  return {
    url,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

module.exports = {
  serializeRecording,
  transitionAttempt,
  startRecording,
  stopRecording,
  applyProviderEvent,
  finalizeVerifiedOutput,
  listRecordings,
  getRecording,
  accessLink,
  findNonterminalAttempt,
};
