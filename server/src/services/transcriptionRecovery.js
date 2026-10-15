"use strict";

const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const Recording = require("../models/Recording");
const { TRANSCRIPTION_STATES } = require("../constants/transcriptionLimits");
const transcriptionMetrics = require("../utils/transcriptionMetrics");

// Bounded durable reconciler for the Mongo commit -> queue-add gap.
//
// - pending_enqueue intents older than ENQUEUE_STUCK_MS are re-added
//   with the deterministic jobId (dedupe: an existing waiting/active
//   job is returned as-is, never duplicated).
// - Each candidate is re-checked for eligibility before re-queueing:
//   consent withdrawn meanwhile becomes blocked, provider-disabled
//   stays pending for the next pass (never failed by the sweeper).
// - Atomic lease claim on (runId, version, expired/absent lease) so
//   multiple replicas never requeue the same run twice.
// - No external RPC runs inside a DB step; Redis loss only delays
//   work (intent persists) — eligible work is never silently lost.
async function reconcilePendingEnqueues({ now } = {}) {
  const env = getEnv();
  if (!env.redisUrl) {
    return { scanned: 0, claimed: 0, requeued: 0, blocked: 0 };
  }
  const at = typeof now === "number" ? now : Date.now();
  const stuckBefore = new Date(at - 60000);
  const batch = 20;
  const candidates = await Recording.find(
    {
      "transcription.state": TRANSCRIPTION_STATES.PENDING_ENQUEUE,
      "transcription.enqueuedAt": { $lte: stuckBefore },
    },
    { _id: 1, meetingId: 1, transcription: 1 }
  )
    .sort({ "transcription.enqueuedAt": 1 })
    .limit(batch)
    .lean();

  let claimed = 0;
  let requeued = 0;
  let blocked = 0;
  const { addTranscriptionJob } = require("../queues/transcriptionQueue");
  for (const candidate of candidates) {
    const tx = candidate.transcription || {};
    if (!tx.runId) {
      continue;
    }
    const leaseUntil = new Date(at + 60000);
    const owned = await Recording.findOneAndUpdate(
      {
        _id: candidate._id,
        "transcription.runId": tx.runId,
        "transcription.version": tx.version || 0,
        "transcription.state": TRANSCRIPTION_STATES.PENDING_ENQUEUE,
        $or: [
          { "transcription.leaseUntil": null },
          { "transcription.leaseUntil": { $lte: new Date(at) } },
        ],
      },
      { $set: { "transcription.leaseUntil": leaseUntil } },
      { new: true, projection: { _id: 1, meetingId: 1, transcription: 1 } }
    ).lean();
    if (!owned) {
      continue;
    }
    claimed += 1;
    try {
      const {
        checkTranscriptionEligibility,
      } = require("./transcriptionService");
      const recording = await Recording.findById(candidate._id, {
        meetingId: 1,
        state: 1,
        storage: 1,
        output: 1,
        consentRevoked: 1,
        providerEgressId: 1,
      }).lean();
      await checkTranscriptionEligibility({
        meetingId: recording.meetingId,
        recording,
      });
      await addTranscriptionJob({
        recordingId: String(candidate._id),
        runId: tx.runId,
        runVersion: tx.runVersion,
      });
      await Recording.findOneAndUpdate(
        { _id: candidate._id, "transcription.runId": tx.runId },
        {
          $set: {
            "transcription.state": TRANSCRIPTION_STATES.QUEUED,
            "transcription.leaseUntil": null,
          },
          $inc: { "transcription.version": 1 },
        }
      ).lean();
      transcriptionMetrics.observeEnqueue();
      requeued += 1;
    } catch (err) {
      if (err && err.code === "CONSENT_BLOCKED") {
        try {
          const {
            transitionTranscription,
          } = require("./transcriptionService");
          await transitionTranscription(
            candidate._id,
            (owned.transcription && owned.transcription.version) || 0,
            tx.runId,
            TRANSCRIPTION_STATES.PENDING_ENQUEUE,
            TRANSCRIPTION_STATES.BLOCKED,
            { "transcription.errorCode": "CONSENT_WITHDRAWN" }
          );
          transcriptionMetrics.observeBlocked("CONSENT_WITHDRAWN");
          blocked += 1;
        } catch (_unused) {
          // Fence loss: another writer owns the run now.
        }
      } else {
        logger.error("transcription_reconcile_failed", {
          code: err && err.code ? String(err.code) : "UNKNOWN",
        });
      }
    }
  }
  return { scanned: candidates.length, claimed, requeued, blocked };
}

// Durable auto-enqueue backstop: ready recordings in ended meetings
// with NO transcription intent (missed ready/end triggers, e.g. crash
// between ready-persist and intent-persist) gain an intent when
// eligible. Bounded scan; per-recording eligibility decides.
async function reconcileMissingIntents({ now } = {}) {
  const env = getEnv();
  if (!env.redisUrl) {
    return { scanned: 0, enqueued: 0 };
  }
  void now;
  const batch = 20;
  const candidates = await Recording.find(
    {
      state: "ready",
      $or: [
        { "transcription.state": { $exists: false } },
        { "transcription.state": null },
      ],
      updatedAt: { $lte: new Date(Date.now() - 60000) },
    },
    { _id: 1, meetingId: 1, updatedAt: 1 }
  )
    .sort({ updatedAt: 1 })
    .limit(batch)
    .lean();
  let enqueued = 0;
  const { maybeAutoEnqueue } = require("./transcriptionService");
  for (const candidate of candidates) {
    try {
      const result = await maybeAutoEnqueue({
        meetingId: candidate.meetingId,
        recordingId: candidate._id,
      });
      if (result) {
        enqueued += 1;
      }
    } catch (_unused) {
      // Ineligible or raced; next pass reconsiders only if still
      // intent-free (blocked runs carry state and leave this scan).
    }
  }
  return { scanned: candidates.length, enqueued };
}

module.exports = { reconcilePendingEnqueues, reconcileMissingIntents, reconcileStrandedRuns };

// Stranded-run backstop: nonterminal runs whose queue job is gone
// (consumed-before-commit race, crash after pickup, Redis loss) gain
// a fresh execution via the deterministic jobId — dedupe makes the
// re-add safe even when a live execution still exists (add returns the
// live job instead of forking). Rules:
// - queued older than the threshold with no fresh requeue marker:
//   mark (leaseUntil throttle, ignored by the claim path for queued)
//   and re-add.
// - running/retrying older than the threshold with an expired/absent
//   lease: fenced handoff to retrying under reconciler ownership,
//   then re-add. A valid lease means a live owner — skip.
// - The claim fence + chunk checkpoints + fenced publish make any
//   duplicate execution converge without double-publish.
const STRANDED_AFTER_MS = 120000;

async function reconcileStrandedRuns({ now } = {}) {
  const env = getEnv();
  if (!env.redisUrl) {
    return { scanned: 0, requeued: 0, handedOff: 0 };
  }
  const at = typeof now === "number" ? now : Date.now();
  const olderThan = new Date(at - STRANDED_AFTER_MS);
  const candidates = await Recording.find(
    {
      "transcription.state": {
        $in: [TRANSCRIPTION_STATES.QUEUED, TRANSCRIPTION_STATES.RUNNING, TRANSCRIPTION_STATES.RETRYING],
      },
      "transcription.enqueuedAt": { $lte: olderThan },
      $or: [
        { "transcription.state": TRANSCRIPTION_STATES.QUEUED },
        { "transcription.leaseUntil": null },
        { "transcription.leaseUntil": { $lte: new Date(at) } },
      ],
    },
    { _id: 1, meetingId: 1, transcription: 1 }
  )
    .sort({ "transcription.enqueuedAt": 1 })
    .limit(20)
    .lean();

  let requeued = 0;
  let handedOff = 0;
  const { addTranscriptionJob } = require("../queues/transcriptionQueue");
  for (const candidate of candidates) {
    const tx = candidate.transcription || {};
    if (!tx.runId) {
      continue;
    }
    try {
      if (tx.state === TRANSCRIPTION_STATES.QUEUED) {
        // Throttle marker: skip when requeued recently.
        if (tx.leaseUntil && new Date(tx.leaseUntil).getTime() > at) {
          continue;
        }
        await Recording.findOneAndUpdate(
          { _id: candidate._id, "transcription.runId": tx.runId },
          { $set: { "transcription.leaseUntil": new Date(at + 60000) } }
        ).lean();
        await addTranscriptionJob({
          recordingId: String(candidate._id),
          runId: tx.runId,
          runVersion: tx.runVersion,
        });
        requeued += 1;
      } else {
        // running/retrying with expired lease: fenced handoff.
        const {
          transitionTranscription,
        } = require("./transcriptionService");
        const moved = await transitionTranscription(
          candidate._id,
          tx.version || 0,
          tx.runId,
          [TRANSCRIPTION_STATES.RUNNING, TRANSCRIPTION_STATES.RETRYING],
          TRANSCRIPTION_STATES.RETRYING,
          {
            "transcription.workerId": "reconciler",
            "transcription.leaseUntil": new Date(at + 60000),
          }
        );
        if (!moved) {
          continue;
        }
        handedOff += 1;
        await addTranscriptionJob({
          recordingId: String(candidate._id),
          runId: tx.runId,
          runVersion: tx.runVersion,
        });
        requeued += 1;
      }
    } catch (err) {
      logger.error("transcription_stranded_reconcile_failed", {
        code: err && err.code ? String(err.code) : "UNKNOWN",
      });
    }
  }
  return { scanned: candidates.length, requeued, handedOff };
}
