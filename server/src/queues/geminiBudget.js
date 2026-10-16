"use strict";

const { getEnv } = require("../config/env");

// Cluster-wide shared Gemini provider-call budget. Phase 4
// (intellmeet:tx:calls:*) and Phase 5 (intellmeet:ix:calls:*)
// counters subdivide spend per pipeline, but independent caps can
// jointly exceed the project/provider quota — so every provider call
// in EITHER pipeline also takes a slot here first. The project cap is
// a single Redis INCR+EXPIRE counter both pipelines share.
//
// Precision note: the shared check and the per-phase check are two
// separate atomic increments, not one atomic pair — at the exact
// boundary a call may consume one counter while the other rejects.
// Both counters are approximate admission bounds reconciled against
// observed usage metrics, never exact billing (BullMQ idempotence
// likewise never implies exactly-once provider billing). No RPM, TPM,
// or monetary-spend guard exists in this repo: the provider account
// holder must size GEMINI_SHARED_MAX_CALLS_PER_DAY (and the phase
// caps) against the project's actual Gemini quota, and live quota
// behavior/RPM/TPM/spend remain unverified (mock-only tests).

function sharedDayKey(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return `intellmeet:gemini:calls:${date.toISOString().slice(0, 10)}`;
}

// Throws PROVIDER_QUOTA_EXHAUSTED (terminal for the run) when the
// shared project budget is spent. Takes an owned connection from the
// calling queue module — the key is connection-agnostic.
async function takeSharedCallSlot(connection) {
  const env = getEnv();
  const key = sharedDayKey(Date.now());
  const count = await connection.incr(key);
  if (count === 1) {
    await connection.expire(key, 86400 + 3600);
  }
  if (count > env.geminiSharedMaxCallsPerDay) {
    const err = new Error("Shared Gemini budget exhausted.");
    err.code = "PROVIDER_QUOTA_EXHAUSTED";
    throw err;
  }
  return count;
}

module.exports = { takeSharedCallSlot, sharedDayKey };
