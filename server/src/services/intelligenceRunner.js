"use strict";

const crypto = require("node:crypto");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const MeetingIntelligence = require("../models/MeetingIntelligence");
const ActionItem = require("../models/ActionItem");
const Recording = require("../models/Recording");
const TranscriptSegment = require("../models/TranscriptSegment");
const provider = require("./geminiIntelligenceProvider");
const {
  checkIntelligenceEligibility,
  transitionIntelligence,
  buildPromptV1,
  buildResponseSchemaV1,
  suggestionKeyFor,
  emitIntelligenceStatus,
} = require("./intelligenceService");
const { validateIntelligencePayload } = require("../validation/intelligenceValidation");
const {
  INTELLIGENCE_STATES,
  INTELLIGENCE_LIMITS,
  isTerminalIntelligenceState,
  isRetryableIntelligenceError,
  safeIntelligenceErrorCode,
} = require("../constants/intelligenceLimits");
const intelligenceMetrics = require("../utils/intelligenceMetrics");

const RUN_PROJECTION = {
  meetingId: 1,
  recordingId: 1,
  sourceTranscriptRunId: 1,
  sourceTranscriptRunVersion: 1,
  sourceSegmentCount: 1,
  runId: 1,
  runVersion: 1,
  version: 1,
  state: 1,
  pipelineVersion: 1,
  model: 1,
  promptVersion: 1,
  schemaVersion: 1,
  contextVersion: 1,
  consentNoticeVersion: 1,
  errorCode: 1,
  leaseUntil: 1,
  workerId: 1,
  attempts: 1,
  enqueuedAt: 1,
  startedAt: 1,
  usage: 1,
};

function workerIdentity() {
  return `ixw_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
}

// Bounded step deadline WITH provider cancellation. The controller
// aborts on timeout so the provider HTTP wait ends promptly; the
// provider documents abort as client-only (the request may still bill
// server-side), so a timed-out call's outcome stays UNKNOWN: callers
// keep idempotent writes + bounded retries, and exactly-once billing
// is never claimed. A provider CANCELLED that races our own timeout
// is normalized to the timeout code (run-cancellation is fenced
// separately by the caller, never inferred from this code).
function withStepDeadline(ms, code, invoke) {
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch (_unused) {
        // Abort must never mask the timeout outcome.
      }
      const err = new Error("Step timed out.");
      err.code = code;
      reject(err);
    }, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  const attempt = invoke(controller.signal).catch((err) => {
    if (timedOut || (controller.signal.aborted && err && err.code === "CANCELLED")) {
      const timeoutErr = new Error("Step timed out.");
      timeoutErr.code = code;
      throw timeoutErr;
    }
    throw err;
  });
  return Promise.race([attempt, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function claimRun({ intelligenceId, runId, workerId }) {
  const doc = await MeetingIntelligence.findById(intelligenceId, RUN_PROJECTION).lean();
  if (!doc || doc.runId !== runId) {
    return { stale: true };
  }
  if (
    doc.state === INTELLIGENCE_STATES.COMPLETE ||
    doc.state === INTELLIGENCE_STATES.FAILED ||
    doc.state === INTELLIGENCE_STATES.CANCELLED ||
    doc.state === INTELLIGENCE_STATES.BLOCKED
  ) {
    return { stale: true };
  }
  const now = Date.now();
  const leaseValid =
    doc.leaseUntil && new Date(doc.leaseUntil).getTime() > now && doc.state === INTELLIGENCE_STATES.RUNNING;
  if (leaseValid && doc.workerId && doc.workerId !== workerId) {
    return { deferred: true };
  }
  const fromStates = [];
  if (doc.state === INTELLIGENCE_STATES.QUEUED || doc.state === INTELLIGENCE_STATES.RETRYING) {
    fromStates.push(doc.state);
  } else if (doc.state === INTELLIGENCE_STATES.PENDING_ENQUEUE) {
    return { early: true };
  } else if (doc.state === INTELLIGENCE_STATES.RUNNING) {
    fromStates.push(INTELLIGENCE_STATES.RUNNING);
  } else {
    return { stale: true };
  }
  const env = getEnv();
  const toState = doc.state === INTELLIGENCE_STATES.RUNNING ? INTELLIGENCE_STATES.RETRYING : INTELLIGENCE_STATES.RUNNING;
  const claimed = await transitionIntelligence(doc._id, doc.version || 0, runId, fromStates, toState, {
    workerId,
    leaseUntil: new Date(now + env.intelRunTimeoutMs),
    startedAt: doc.startedAt || new Date(),
    attempts: (doc.attempts || 0) + 1,
  });
  if (!claimed) {
    return { stale: true };
  }
  const running =
    toState === INTELLIGENCE_STATES.RUNNING
      ? claimed
      : await transitionIntelligence(claimed._id, claimed.version, runId, INTELLIGENCE_STATES.RETRYING, INTELLIGENCE_STATES.RUNNING, {});
  return running ? { doc: running } : { stale: true };
}

async function readCurrentRun(intelligenceId, runId) {
  const doc = await MeetingIntelligence.findById(intelligenceId, RUN_PROJECTION).lean();
  if (!doc || doc.runId !== runId) {
    return null;
  }
  return doc;
}

async function failRun({ intelligenceId, runId, version, code, meetingId }) {
  const safe = safeIntelligenceErrorCode(code);
  const failed = await transitionIntelligence(
    intelligenceId,
    version,
    runId,
    [INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING],
    INTELLIGENCE_STATES.FAILED,
    { errorCode: safe }
  );
  const current = failed || (await MeetingIntelligence.findById(intelligenceId, RUN_PROJECTION).lean());
  if (current) {
    intelligenceMetrics.observeFailed(safe);
    emitIntelligenceStatus(String(meetingId || current.meetingId), current);
  }
  const err = new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, "Intelligence failed.", safe);
  err.terminal = true;
  throw err;
}

async function blockRun({ intelligenceId, runId, version, code, meetingId }) {
  const safe = safeIntelligenceErrorCode(code);
  const blocked = await transitionIntelligence(
    intelligenceId,
    version,
    runId,
    [INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING],
    INTELLIGENCE_STATES.BLOCKED,
    { errorCode: safe }
  );
  const current = blocked || (await MeetingIntelligence.findById(intelligenceId, RUN_PROJECTION).lean());
  if (current) {
    intelligenceMetrics.observeBlocked(safe);
    emitIntelligenceStatus(String(meetingId || current.meetingId), current);
  }
  const err = new AppError(HTTP_STATUS.FORBIDDEN, "Intelligence blocked.", safe);
  err.terminal = true;
  throw err;
}

// Load the pinned source segments in order. Bounded: hard row cap from
// env; callers treat over-cap input as SOURCE_TOO_LARGE (explicit
// incomplete), never silent truncation.
async function loadSourceSegments({ recordingId, transcriptRunId, transcriptRunVersion }) {
  const env = getEnv();
  const rows = await TranscriptSegment.find(
    { recordingId, runId: transcriptRunId, runVersion: transcriptRunVersion },
    { chunkIndex: 1, ordinal: 1, startMs: 1, endMs: 1, text: 1, speakerLabel: 1 }
  )
    .sort({ chunkIndex: 1, ordinal: 1 })
    .limit(env.intelMaxSourceSegments + 1)
    .lean();
  return rows;
}

function segmentIdOf(row) {
  return `${row.chunkIndex}:${row.ordinal}`;
}

// Bounded ordered source windows. Each window carries original segment
// IDs; all accepted windows must be covered or the run reports
// incomplete — windows are never silently dropped.
function planWindows(rows, windowChars, maxWindows) {
  const windows = [];
  let current = { segments: [], chars: 0 };
  for (const row of rows) {
    const line = `[${segmentIdOf(row)}] ${row.speakerLabel || "speaker"}: ${row.text}`;
    if (current.segments.length > 0 && current.chars + line.length > windowChars) {
      windows.push(current);
      current = { segments: [], chars: 0 };
    }
    current.segments.push(row);
    current.chars += line.length + 1;
  }
  if (current.segments.length > 0) {
    windows.push(current);
  }
  if (windows.length > maxWindows) {
    return { windows: null, overBudget: true };
  }
  return { windows, overBudget: false };
}

function windowLines(window) {
  return window.segments
    .map((row) => `[${segmentIdOf(row)}] ${row.speakerLabel || "speaker"}: ${row.text}`)
    .join("\n");
}

async function processIntelligenceJob(job, { workerId } = {}) {
  const env = getEnv();
  const wid = workerId || workerIdentity();
  const data = (job && job.data) || {};
  const { UnrecoverableError: PayloadError } = require("bullmq");
  const mongoose = require("mongoose");
  const intelligenceId = data.intelligenceId;
  const runId = data.runId;
  const runVersion = data.runVersion;
  if (
    !intelligenceId ||
    !mongoose.Types.ObjectId.isValid(intelligenceId) ||
    !runId ||
    typeof runId !== "string" ||
    !Number.isInteger(runVersion)
  ) {
    throw new PayloadError("Invalid intelligence job payload.");
  }
  const startedAt = Date.now();
  const claim = await claimRun({ intelligenceId, runId, workerId: wid });
  if (claim.stale || claim.deferred) {
    return { skipped: claim.deferred ? "deferred" : "stale" };
  }
  if (claim.early) {
    intelligenceMetrics.observeRetry();
    const early = new Error("Run intent not yet committed; redelivering.");
    early.code = "PROVIDER_UNAVAILABLE";
    throw early;
  }
  let doc = claim.doc;
  const meetingId = String(doc.meetingId);
  const versionOf = () => doc.version;
  const fail = (code) =>
    failRun({ intelligenceId: doc._id, runId, version: versionOf(), code, meetingId });
  const block = (code) =>
    blockRun({ intelligenceId: doc._id, runId, version: versionOf(), code, meetingId });
  const refresh = async () => {
    const current = await readCurrentRun(doc._id, runId);
    if (current) {
      doc = current;
    }
    return current;
  };

  try {
    // Re-check eligibility at run start: consent may have been
    // withdrawn between enqueue and pickup.
    const recording = await Recording.findById(doc.recordingId, {
      meetingId: 1,
      state: 1,
      consentRevoked: 1,
      transcription: 1,
    }).lean();
    if (!recording) {
      await refresh();
      await fail("OUTPUT_MISSING");
    }
    try {
      const pinned = await checkIntelligenceEligibility({ meetingId: doc.meetingId, recording });
      if (
        pinned.transcriptRunId !== doc.sourceTranscriptRunId ||
        pinned.transcriptRunVersion !== doc.sourceTranscriptRunVersion
      ) {
        // Source moved under us (new transcript publish): this run is
        // superseded — a fresh run pins the new source instead of
        // mixing versions.
        await refresh();
        await block("TRANSCRIPT_SUPERSEDED");
      }
    } catch (err) {
      await refresh();
      if (err && err.code === "CONSENT_BLOCKED") {
        await block("CONSENT_WITHDRAWN");
      }
      await block(safeIntelligenceErrorCode(err && err.code));
    }

    const rows = await loadSourceSegments({
      recordingId: doc.recordingId,
      transcriptRunId: doc.sourceTranscriptRunId,
      transcriptRunVersion: doc.sourceTranscriptRunVersion,
    });
    if (rows.length === 0) {
      await refresh();
      await fail("TRANSCRIPT_NOT_READY");
    }
    if (rows.length > env.intelMaxSourceSegments) {
      await refresh();
      await fail("SOURCE_TOO_LARGE");
    }
    const totalBytes = rows.reduce((sum, row) => sum + String(row.text || "").length, 0);
    if (totalBytes > env.intelMaxSourceBytes) {
      await refresh();
      await fail("SOURCE_TOO_LARGE");
    }
    if (rows.length !== doc.sourceSegmentCount) {
      // Source changed between schedule and run (segments added or
      // pruned): supersede rather than cover a different input.
      await refresh();
      await block("TRANSCRIPT_SUPERSEDED");
    }

    const validIds = new Set(rows.map(segmentIdOf));
    const byId = new Map(rows.map((row) => [segmentIdOf(row), row]));
    const planned = planWindows(rows, env.intelWindowChars, env.intelMaxWindows);
    if (planned.overBudget || !planned.windows) {
      await refresh();
      await fail("SOURCE_TOO_LARGE");
    }
    const windows = planned.windows;
    const runDeadline = startedAt + env.intelRunTimeoutMs;
    const responseSchema = buildResponseSchemaV1();
    const { takeProviderCallSlot } = require("../queues/intelligenceQueue");

    const onCall = async () => {
      intelligenceMetrics.observeProviderCall();
      await takeProviderCallSlot();
    };

    const windowOutputs = [];
    for (let index = 0; index < windows.length; index += 1) {
      if (Date.now() > runDeadline) {
        await refresh();
        await fail("OUTPUT_INCOMPLETE");
      }
      // Eligibility re-check before EVERY external call.
      const live = await Recording.findById(doc.recordingId, {
        meetingId: 1,
        state: 1,
        consentRevoked: 1,
        transcription: 1,
      }).lean();
      try {
        await checkIntelligenceEligibility({ meetingId: doc.meetingId, recording: live });
      } catch (err) {
        await refresh();
        await block(err && err.code === "CONSENT_BLOCKED" ? "CONSENT_WITHDRAWN" : safeIntelligenceErrorCode(err && err.code));
      }
      const current = await readCurrentRun(doc._id, runId);
      if (!current || current.state === INTELLIGENCE_STATES.CANCELLED) {
        const err = new Error("Run was cancelled.");
        err.code = "CANCELLED";
        err.cancelled = true;
        throw err;
      }

      const prompt = buildPromptV1({
        windowLabel: windows.length === 1 ? "complete transcript" : `window ${index + 1} of ${windows.length}`,
        segmentLines: windowLines(windows[index]),
        isReconcile: false,
        windowCount: windows.length,
      });
      const stepStarted = Date.now();
      await MeetingIntelligence.findOneAndUpdate(
        { _id: doc._id, runId },
        { $set: { externalInFlight: true } }
      ).lean();
      let payload;
      try {
        await onCall();
        payload = await withStepDeadline(
          env.intelStepTimeoutMs,
          "PROVIDER_TIMEOUT",
          (signal) =>
            provider.generateIntelligence({
              windowKey: windows.length === 1 ? "default" : `window:${index}`,
              prompt,
              responseSchema,
              signal,
            })
        );
        intelligenceMetrics.observeWindow();
      } catch (err) {
        await MeetingIntelligence.findOneAndUpdate(
          { _id: doc._id, runId },
          { $set: { externalInFlight: false } }
        ).lean();
        await refresh();
        await handleCallError({ doc, runId, err, meetingId, refresh, fail, block });
      }
      await MeetingIntelligence.findOneAndUpdate(
        { _id: doc._id, runId },
        {
          $set: { externalInFlight: false },
          $inc: { "usage.providerCalls": 1, "usage.observedMs": Date.now() - stepStarted },
        }
      ).lean();
      await refresh();
      let validated;
      try {
        validated = validateIntelligencePayload(payload, { validIds });
      } catch (err) {
        if (!err.code) {
          err.code = "OUTPUT_MALFORMED";
        }
        await handleCallError({ doc, runId, err, meetingId, refresh, fail, block });
      }
      windowOutputs.push(validated);
    }

    // Reconcile stage for multi-window runs: bounded reduce over the
    // validated per-window outputs (segment IDs carried through).
    let merged = windowOutputs[0];
    if (windowOutputs.length > 1) {
      if (Date.now() > runDeadline) {
        await refresh();
        await fail("OUTPUT_INCOMPLETE");
      }
      const live = await Recording.findById(doc.recordingId, {
        meetingId: 1,
        state: 1,
        consentRevoked: 1,
        transcription: 1,
      }).lean();
      try {
        await checkIntelligenceEligibility({ meetingId: doc.meetingId, recording: live });
      } catch (err) {
        await refresh();
        await block(err && err.code === "CONSENT_BLOCKED" ? "CONSENT_WITHDRAWN" : safeIntelligenceErrorCode(err && err.code));
      }
      const digest = windowOutputs
        .map((out, index) => `--- window ${index + 1} ---\n${JSON.stringify(out)}`)
        .join("\n");
      const prompt = buildPromptV1({
        windowLabel: "reconcile",
        segmentLines: digest,
        isReconcile: true,
        windowCount: windowOutputs.length,
      });
      const stepStarted = Date.now();
      await MeetingIntelligence.findOneAndUpdate(
        { _id: doc._id, runId },
        { $set: { externalInFlight: true } }
      ).lean();
      let payload;
      try {
        await onCall();
        payload = await withStepDeadline(
          env.intelStepTimeoutMs,
          "PROVIDER_TIMEOUT",
          (signal) => provider.generateIntelligence({ windowKey: "reconcile", prompt, responseSchema, signal })
        );
      } catch (err) {
        await MeetingIntelligence.findOneAndUpdate(
          { _id: doc._id, runId },
          { $set: { externalInFlight: false } }
        ).lean();
        await refresh();
        await handleCallError({ doc, runId, err, meetingId, refresh, fail, block });
      }
      await MeetingIntelligence.findOneAndUpdate(
        { _id: doc._id, runId },
        {
          $set: { externalInFlight: false },
          $inc: { "usage.providerCalls": 1, "usage.observedMs": Date.now() - stepStarted },
        }
      ).lean();
      await refresh();
      try {
        merged = validateIntelligencePayload(payload, { validIds });
      } catch (err) {
        if (!err.code) {
          err.code = "OUTPUT_MALFORMED";
        }
        await handleCallError({ doc, runId, err, meetingId, refresh, fail, block });
      }
      // Reconciliation must not manufacture evidence: every cited id
      // re-validated above; coverage requires every accepted window
      // present — windows.length > 1 with all outputs validated here.
    }

    // Final eligibility + timestamp derivation (server-side from
    // stored segments, never model values).
    const liveFinal = await Recording.findById(doc.recordingId, {
      meetingId: 1,
      state: 1,
      consentRevoked: 1,
      transcription: 1,
    }).lean();
    try {
      await checkIntelligenceEligibility({ meetingId: doc.meetingId, recording: liveFinal });
    } catch (err) {
      await refresh();
      await block(err && err.code === "CONSENT_BLOCKED" ? "CONSENT_WITHDRAWN" : safeIntelligenceErrorCode(err && err.code));
    }
    const withTimes = (entry) => {
      const times = (entry.evidence.segmentIds || []).map((id) => byId.get(id)).filter(Boolean);
      const starts = times.map((row) => row.startMs).filter((value) => Number.isFinite(value));
      const ends = times.map((row) => row.endMs).filter((value) => Number.isFinite(value));
      return {
        text: entry.text,
        evidence: {
          segmentIds: entry.evidence.segmentIds,
          startMs: starts.length > 0 ? Math.min(...starts) : null,
          endMs: ends.length > 0 ? Math.max(...ends) : null,
        },
      };
    };
    const summaries = (merged.summaryBullets || []).map(withTimes);
    const decisions = merged.decisions.map(withTimes);
    const blockers = merged.blockers.map(withTimes);
    const unresolvedQuestions = (merged.unresolvedQuestions || []).map(withTimes);
    const actions = merged.suggestedActions.map((entry) => ({
      ...entry,
      evidence: withTimes({ text: entry.title, evidence: entry.evidence }).evidence,
    }));

    // Stage outputs + suggestions, then publish via the conditional
    // run pointer: no externally visible half-published result.
    // Suggestions upsert by stable key; already reviewed rows
    // (approved/rejected/edited) are never reset or rewritten.
    const staged = await transitionIntelligence(
      doc._id,
      versionOf(),
      runId,
      [INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING],
      INTELLIGENCE_STATES.RUNNING,
      {
        summaryBullets: summaries,
        decisions,
        blockers,
        unresolvedQuestions,
        workerId: wid,
      }
    );
    if (!staged) {
      await ActionItem.deleteMany({ intelligenceId: doc._id }).lean();
      const err = new Error("Run superseded during processing.");
      err.code = "RUN_SUPERSEDED";
      throw err;
    }
    doc = (await readCurrentRun(doc._id, runId)) || staged;

    for (const action of actions) {
      const key = suggestionKeyFor({ title: action.title, segmentIds: action.evidence.segmentIds });
      const taskIdempotencyKey = crypto
        .createHash("sha256")
        .update(`ix-task-v1|${runId}|${key}`)
        .digest("hex")
        .slice(0, 32);
      await ActionItem.findOneAndUpdate(
        { intelligenceId: doc._id, suggestionKey: key },
        {
          $setOnInsert: {
            meetingId: doc.meetingId,
            recordingId: doc.recordingId,
            intelligenceId: doc._id,
            intelligenceRunId: runId,
            intelligenceRunVersion: runVersion,
            suggestionKey: key,
            titleProposed: action.title,
            detailProposed: action.detail,
            proposedOwnerText: action.proposedOwnerText,
            proposedDueDateText: action.dueDateText,
            evidenceSegmentIds: action.evidence.segmentIds,
            evidenceStartMs: action.evidence.startMs,
            evidenceEndMs: action.evidence.endMs,
            state: "proposed",
            version: 0,
            taskLink: { status: "blocked", reason: "NOT_APPROVED" },
            taskIdempotencyKey,
          },
        },
        { upsert: true }
      ).lean();
    }

    const published = await transitionIntelligence(
      doc._id,
      doc.version,
      runId,
      [INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING],
      INTELLIGENCE_STATES.COMPLETE,
      {
        completedAt: new Date(),
        publishedAt: new Date(),
        errorCode: null,
        externalInFlight: false,
      }
    );
    const current = published || (await MeetingIntelligence.findById(doc._id, RUN_PROJECTION).lean());
    if (
      published &&
      current &&
      current.runId === runId &&
      current.state === INTELLIGENCE_STATES.COMPLETE
    ) {
      intelligenceMetrics.observeComplete();
      emitIntelligenceStatus(meetingId, current);
      return { complete: true, windows: windows.length, actions: actions.length };
    }
    return { skipped: "superseded" };
  } catch (err) {
    const { UnrecoverableError } = require("bullmq");
    if (err && (err.terminal || err.cancelled)) {
      const done = new UnrecoverableError(err.message);
      done.code = err.code;
      throw done;
    }
    if (err && err.code === "RUN_SUPERSEDED") {
      return { skipped: "superseded" };
    }
    const code = safeIntelligenceErrorCode(err && err.code);
    if (isRetryableIntelligenceError(code)) {
      const current = await readCurrentRun(intelligenceId, runId);
      if (current && !isTerminalIntelligenceState(current.state)) {
        await transitionIntelligence(
          intelligenceId,
          current.version,
          runId,
          [INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING],
          INTELLIGENCE_STATES.RETRYING,
          { errorCode: code }
        );
        intelligenceMetrics.observeRetry();
      }
      const retryable = new Error(err && err.message ? err.message : "Transient failure.");
      retryable.code = code;
      throw retryable;
    }
    const current = await readCurrentRun(intelligenceId, runId);
    if (current && !isTerminalIntelligenceState(current.state)) {
      await transitionIntelligence(
        intelligenceId,
        current.version,
        runId,
        [INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING],
        INTELLIGENCE_STATES.FAILED,
        { errorCode: code }
      );
      intelligenceMetrics.observeFailed(code);
      emitIntelligenceStatus(meetingId, await readCurrentRun(intelligenceId, runId));
    }
    const { UnrecoverableError: TerminalError } = require("bullmq");
    const terminal = new TerminalError(err && err.message ? err.message : "Intelligence failed.");
    terminal.code = code;
    throw terminal;
  }
}

async function handleCallError({ doc, runId, err, meetingId, refresh, fail, block }) {
  const code = safeIntelligenceErrorCode(err && err.code);
  if (err && err.code === "CANCELLED") {
    throw err;
  }
  if (
    code === "CONSENT_BLOCKED" ||
    code === "INTEGRATION_BLOCKER" ||
    code === "PROVIDER_AUTH_FAILED" ||
    code === "PROVIDER_QUOTA_EXHAUSTED" ||
    code === "OUTPUT_SAFETY_BLOCKED" ||
    code === "OUTPUT_MALFORMED" ||
    code === "OUTPUT_TRUNCATED" ||
    code === "EVIDENCE_INVALID" ||
    code === "TRANSCRIPT_SUPERSEDED" ||
    code === "SOURCE_TOO_LARGE" ||
    code === "TRANSCRIPT_NOT_READY"
  ) {
    await refresh();
    if (code === "CONSENT_BLOCKED") {
      await block("CONSENT_WITHDRAWN");
    } else if (code === "INTEGRATION_BLOCKER") {
      await block(code);
    } else if (code === "TRANSCRIPT_SUPERSEDED" || code === "TRANSCRIPT_NOT_READY") {
      await block(code);
    } else if (code === "SOURCE_TOO_LARGE") {
      await fail(code);
    } else {
      await fail(code);
    }
  }
  const retryable = new Error(err && err.message ? err.message : "Call failed transiently.");
  retryable.code = code;
  throw retryable;
}

module.exports = { processIntelligenceJob, claimRun, planWindows, workerIdentity };
