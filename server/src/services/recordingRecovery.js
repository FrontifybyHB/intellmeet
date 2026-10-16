"use strict";

const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const Recording = require("../models/Recording");
const provider = require("./recordingProvider");
const { applyProviderEvent, transitionAttempt } = require("./recordingService");
const {
  NONTERMINAL_STATES,
  RECORDING_STATES,
} = require("../constants/recordingLimits");
const recordingMetrics = require("../utils/recordingMetrics");

// Bounded durable recovery for ambiguous start/stop/end and missed
// terminal updates. No new queue: recovery is an indexed, leased scan
// over the Recording collection — callable from tests, a boot probe,
// or an operator endpoint — with bounded batch, concurrency of one
// (sequential per call), lease duration, and max attempts.
//
// - Claims use atomic findOneAndUpdate on the expired/absent lease, so
//   multiple replicas never reconcile the same attempt twice.
// - A start timeout stays "unknown" until the provider confirms
//   something: reconcile reads provider state first and never assumes
//   absence. Only after max attempts does unknown degrade to failed
//   (PROVIDER_TIMEOUT_UNKNOWN) — reported, not silent.
// - No external RPC runs inside a DB transaction: the lease write and
//   the provider read are separate, ordered steps.
async function recoverStuck({ now } = {}) {
  const env = getEnv();
  const at = typeof now === "number" ? now : Date.now();
  const batch = env.recordingRecoveryBatch;
  const leaseMs = env.recordingRecoveryLeaseMs;
  const maxAttempts = env.recordingRecoveryMaxAttempts;

  const candidates = await Recording.find(
    {
      state: { $in: NONTERMINAL_STATES },
      recoveryAttempts: { $lt: maxAttempts },
      $or: [
        { recoveryLeaseUntil: null },
        { recoveryLeaseUntil: { $lte: new Date(at) } },
      ],
    },
    { _id: 1, state: 1, updatedAt: 1, providerEgressId: 1, recoveryAttempts: 1, version: 1 }
  )
    .sort({ updatedAt: 1 })
    .limit(batch)
    .lean();

  let claimed = 0;
  let resolved = 0;
  for (const candidate of candidates) {
    const claimedDoc = await Recording.findOneAndUpdate(
      {
        _id: candidate._id,
        version: candidate.version,
        $or: [
          { recoveryLeaseUntil: null },
          { recoveryLeaseUntil: { $lte: new Date(at) } },
        ],
      },
      {
        $set: { recoveryLeaseUntil: new Date(at + leaseMs) },
        $inc: { recoveryAttempts: 1, version: 1 },
      },
      { new: true, projection: { _id: 1, state: 1, providerEgressId: 1, recoveryAttempts: 1, version: 1 } }
    ).lean();
    if (!claimedDoc) {
      continue;
    }
    claimed += 1;
    try {
      const done = await reconcileOne(claimedDoc, maxAttempts);
      if (done) {
        resolved += 1;
      }
    } catch (err) {
      logger.error("recording_recovery_failed", {});
    }
  }
  recordingMetrics.observeRecoveryClaimed(claimed);
  return { claimed, resolved, scanned: candidates.length };
}

async function reconcileOne(doc, maxAttempts) {
  recordingMetrics.observeReconciliation();
  if (doc.providerEgressId) {
    let status = null;
    try {
      status = await provider.getEgressStatus({ egressId: doc.providerEgressId });
    } catch (_unused) {
      status = null;
    }
    if (status && status.status) {
      await applyProviderEvent({
        recordingId: doc._id,
        providerStatus: status.status,
        outputMeta: { egressId: doc.providerEgressId },
      });
      return true;
    }
    // Provider unreachable or egress unknown: keep the lease outcome;
    // attempts bound the retries.
    if (doc.recoveryAttempts + 1 >= maxAttempts && doc.state === RECORDING_STATES.UNKNOWN) {
      const current = await Recording.findById(doc._id, { version: 1, state: 1 }).lean();
      if (current && current.state === RECORDING_STATES.UNKNOWN) {
        await transitionAttempt(
          doc._id,
          current.version,
          RECORDING_STATES.UNKNOWN,
          RECORDING_STATES.FAILED,
          { errorCode: "PROVIDER_TIMEOUT_UNKNOWN" }
        );
        return true;
      }
    }
    return false;
  }
  // No provider correlation persisted (crash after provider creation,
  // before save): without an egress id there is nothing safe to
  // reconcile against — leave for webhook session-matching or degrade
  // unknown after max attempts.
  if (doc.recoveryAttempts + 1 >= maxAttempts && doc.state === RECORDING_STATES.UNKNOWN) {
    const current = await Recording.findById(doc._id, { version: 1, state: 1 }).lean();
    if (current && current.state === RECORDING_STATES.UNKNOWN) {
      await transitionAttempt(
        doc._id,
        current.version,
        RECORDING_STATES.UNKNOWN,
        RECORDING_STATES.FAILED,
        { errorCode: "PROVIDER_TIMEOUT_UNKNOWN" }
      );
      return true;
    }
  }
  return false;
}

module.exports = { recoverStuck };
