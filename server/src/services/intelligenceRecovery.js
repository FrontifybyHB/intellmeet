"use strict";

const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const MeetingIntelligence = require("../models/MeetingIntelligence");
const { INTELLIGENCE_STATES } = require("../constants/intelligenceLimits");
const intelligenceMetrics = require("../utils/intelligenceMetrics");

// Bounded durable reconciler for the Mongo commit -> queue-add gap.
//
// - pending_enqueue intents older than the threshold are re-added with
//   the deterministic jobId (an existing waiting/active job is
//   returned as-is, never duplicated).
// - Each candidate is re-checked for eligibility before re-queueing.
// - Atomic lease claim so multiple replicas never requeue twice.
// - No external RPC runs inside a DB step.
async function reconcilePendingEnqueues({ now } = {}) {
  const env = getEnv();
  if (!env.redisUrl) {
    return { scanned: 0, claimed: 0, requeued: 0, blocked: 0 };
  }
  const at = typeof now === "number" ? now : Date.now();
  const stuckBefore = new Date(at - 60000);
  const candidates = await MeetingIntelligence.find(
    { state: INTELLIGENCE_STATES.PENDING_ENQUEUE, enqueuedAt: { $lte: stuckBefore } },
    { _id: 1, meetingId: 1, runId: 1, runVersion: 1, version: 1 }
  )
    .sort({ enqueuedAt: 1 })
    .limit(20)
    .lean();

  let claimed = 0;
  let requeued = 0;
  let blocked = 0;
  const { addIntelligenceJob } = require("../queues/intelligenceQueue");
  for (const candidate of candidates) {
    if (!candidate.runId) {
      continue;
    }
    const leaseUntil = new Date(at + 60000);
    const owned = await MeetingIntelligence.findOneAndUpdate(
      {
        _id: candidate._id,
        runId: candidate.runId,
        version: candidate.version || 0,
        state: INTELLIGENCE_STATES.PENDING_ENQUEUE,
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date(at) } }],
      },
      { $set: { leaseUntil } },
      { new: true, projection: { _id: 1, runId: 1, runVersion: 1, version: 1 } }
    ).lean();
    if (!owned) {
      continue;
    }
    claimed += 1;
    try {
      await addIntelligenceJob({
        intelligenceId: String(candidate._id),
        runId: candidate.runId,
        runVersion: candidate.runVersion,
      });
      await MeetingIntelligence.findOneAndUpdate(
        { _id: candidate._id, runId: candidate.runId },
        { $set: { state: INTELLIGENCE_STATES.QUEUED, leaseUntil: null }, $inc: { version: 1 } }
      ).lean();
      intelligenceMetrics.observeEnqueue();
      requeued += 1;
    } catch (err) {
      logger.error("intelligence_reconcile_failed", {
        code: err && err.code ? String(err.code) : "UNKNOWN",
      });
    }
  }
  return { scanned: candidates.length, claimed, requeued, blocked };
}

const STRANDED_AFTER_MS = 120000;

// Stranded-run backstop: nonterminal runs whose queue job is gone gain
// a fresh execution via the deterministic jobId. The claim fence +
// staged-then-publish + suggestion upserts make duplicates converge
// without double-publish or task duplication (tasks stay blocked).
async function reconcileStrandedRuns({ now } = {}) {
  const env = getEnv();
  if (!env.redisUrl) {
    return { scanned: 0, requeued: 0, handedOff: 0 };
  }
  const at = typeof now === "number" ? now : Date.now();
  const olderThan = new Date(at - STRANDED_AFTER_MS);
  const candidates = await MeetingIntelligence.find(
    {
      state: { $in: [INTELLIGENCE_STATES.QUEUED, INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING] },
      enqueuedAt: { $lte: olderThan },
      $or: [
        { state: INTELLIGENCE_STATES.QUEUED },
        { leaseUntil: null },
        { leaseUntil: { $lte: new Date(at) } },
      ],
    },
    { _id: 1, runId: 1, runVersion: 1, version: 1, state: 1 }
  )
    .sort({ enqueuedAt: 1 })
    .limit(20)
    .lean();

  let requeued = 0;
  let handedOff = 0;
  const { addIntelligenceJob } = require("../queues/intelligenceQueue");
  for (const candidate of candidates) {
    if (!candidate.runId) {
      continue;
    }
    try {
      if (candidate.state === INTELLIGENCE_STATES.QUEUED) {
        await MeetingIntelligence.findOneAndUpdate(
          { _id: candidate._id, runId: candidate.runId },
          { $set: { leaseUntil: new Date(at + 60000) } }
        ).lean();
        await addIntelligenceJob({
          intelligenceId: String(candidate._id),
          runId: candidate.runId,
          runVersion: candidate.runVersion,
        });
        requeued += 1;
      } else {
        const { transitionIntelligence } = require("./intelligenceService");
        const moved = await transitionIntelligence(
          candidate._id,
          candidate.version || 0,
          candidate.runId,
          [INTELLIGENCE_STATES.RUNNING, INTELLIGENCE_STATES.RETRYING],
          INTELLIGENCE_STATES.RETRYING,
          { workerId: "reconciler", leaseUntil: new Date(at + 60000) }
        );
        if (!moved) {
          continue;
        }
        handedOff += 1;
        await addIntelligenceJob({
          intelligenceId: String(candidate._id),
          runId: candidate.runId,
          runVersion: candidate.runVersion,
        });
        requeued += 1;
      }
    } catch (err) {
      logger.error("intelligence_stranded_reconcile_failed", {
        code: err && err.code ? String(err.code) : "UNKNOWN",
      });
    }
  }
  return { scanned: candidates.length, requeued, handedOff };
}

module.exports = { reconcilePendingEnqueues, reconcileStrandedRuns };
