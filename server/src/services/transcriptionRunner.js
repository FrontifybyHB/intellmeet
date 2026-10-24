"use strict";

const crypto = require("node:crypto");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const Recording = require("../models/Recording");
const TranscriptSegment = require("../models/TranscriptSegment");
const provider = require("./geminiTranscriptionProvider");
const audio = require("./transcriptionAudio");
const { readMockAudioBytesForTests, readStoredObject } = require("./recordingProvider");
const {
  checkTranscriptionEligibility,
  transitionTranscription,
  buildPromptP1,
  buildResponseSchemaS1,
  emitTranscriptionStatus,
} = require("./transcriptionService");
const {
  validateProviderPayload,
} = require("../validation/transcriptionValidation");
const {
  TRANSCRIPTION_STATES,
  TRANSCRIPTION_LIMITS,
  isTerminalTranscriptionState,
  isRetryableTranscriptionError,
  safeTranscriptionErrorCode,
} = require("../constants/transcriptionLimits");
const transcriptionMetrics = require("../utils/transcriptionMetrics");

const RUN_PROJECTION = {
  meetingId: 1,
  state: 1,
  storage: 1,
  output: 1,
  consentRevoked: 1,
  providerEgressId: 1,
  transcription: 1,
};

function workerIdentity() {
  return `w_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
}

// Bounded step deadline. The SDK call itself cannot be cancelled, so
// a timeout win leaves a bounded orphan: externalInFlight stays set
// until the next fence check, and duplicate spend is bounded to one
// un-checkpointed chunk (checkpoints converge on redelivery).
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

// Claim the run for this worker. Returns {doc} when owned, {deferred}
// when a live owner holds the lease, or {stale} when the run moved on
// (superseded/cancelled/terminal — never touch it).
async function claimRun({ recordingId, runId, workerId, jobAttemptsMade, jobAttemptsMax }) {
  const env = getEnv();
  const doc = await Recording.findById(recordingId, RUN_PROJECTION).lean();
  if (!doc || !doc.transcription || doc.transcription.runId !== runId) {
    return { stale: true };
  }
  const tx = doc.transcription;
  if (
    tx.state === TRANSCRIPTION_STATES.COMPLETE ||
    tx.state === TRANSCRIPTION_STATES.FAILED ||
    tx.state === TRANSCRIPTION_STATES.CANCELLED ||
    tx.state === TRANSCRIPTION_STATES.BLOCKED
  ) {
    return { stale: true };
  }
  const now = Date.now();
  const leaseValid =
    tx.leaseUntil && new Date(tx.leaseUntil).getTime() > now && tx.state === TRANSCRIPTION_STATES.RUNNING;
  if (leaseValid && tx.workerId && tx.workerId !== workerId) {
    // A live owner holds the lease (stalled BullMQ redelivery): defer.
    return { deferred: true };
  }
  const fromStates = [];
  if (
    tx.state === TRANSCRIPTION_STATES.QUEUED ||
    tx.state === TRANSCRIPTION_STATES.RETRYING
  ) {
    fromStates.push(tx.state);
  } else if (tx.state === TRANSCRIPTION_STATES.PENDING_ENQUEUE) {
    // Commit/queue race: the job became visible after add but before
    // the intent commit (pending->queued). Never consume it — the
    // processor redelivers via bounded retry instead.
    return { early: true };
  } else if (tx.state === TRANSCRIPTION_STATES.RUNNING) {
    // Lease expired: take over a stalled owner via retrying (the
    // running->retrying edge exists for exactly this handoff).
    fromStates.push(TRANSCRIPTION_STATES.RUNNING);
  } else {
    return { stale: true };
  }
  const toState =
    tx.state === TRANSCRIPTION_STATES.RUNNING
      ? TRANSCRIPTION_STATES.RETRYING
      : TRANSCRIPTION_STATES.RUNNING;
  const claimed = await transitionTranscription(
    doc._id,
    tx.version || 0,
    runId,
    fromStates,
    toState,
    {
      "transcription.workerId": workerId,
      "transcription.leaseUntil": new Date(now + env.transcriptRunTimeoutMs),
      "transcription.startedAt": tx.startedAt || new Date(),
      "transcription.attempts": (tx.attempts || 0) + 1,
    }
  );
  if (!claimed) {
    return { stale: true };
  }
  const running =
    toState === TRANSCRIPTION_STATES.RUNNING
      ? claimed
      : await transitionTranscription(
          doc._id,
          claimed.transcription.version,
          runId,
          TRANSCRIPTION_STATES.RETRYING,
          TRANSCRIPTION_STATES.RUNNING,
          {}
        );
  void jobAttemptsMax;
  return running ? { doc: running } : { stale: true };
}

async function readCurrentRun(recordingId, runId) {
  const doc = await Recording.findById(recordingId, RUN_PROJECTION).lean();
  if (!doc || !doc.transcription || doc.transcription.runId !== runId) {
    return null;
  }
  return doc;
}

async function ensureNotCancelled({ recordingId, runId, providerFileName }) {
  const current = await readCurrentRun(recordingId, runId);
  if (!current || current.transcription.state === TRANSCRIPTION_STATES.CANCELLED) {
    if (providerFileName) {
      try {
        await provider.deleteProviderFile({ fileName: providerFileName });
      } catch (_unused) {
        // Best-effort remote cleanup.
      }
    }
    const err = new Error("Run was cancelled.");
    err.code = "CANCELLED";
    err.cancelled = true;
    throw err;
  }
  return current;
}

async function failRun({ recordingId, runId, version, code, meetingId }) {
  const safe = safeTranscriptionErrorCode(code);
  const failed = await transitionTranscription(
    recordingId,
    version,
    runId,
    [TRANSCRIPTION_STATES.RUNNING, TRANSCRIPTION_STATES.RETRYING],
    TRANSCRIPTION_STATES.FAILED,
    { "transcription.errorCode": safe }
  );
  const current =
    failed || (await Recording.findById(recordingId, RUN_PROJECTION).lean());
  if (current) {
    transcriptionMetrics.observeFailed(safe);
    emitTranscriptionStatus(String(meetingId || current.meetingId), current);
  }
  const err = new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, "Transcription failed.", safe);
  err.terminal = true;
  throw err;
}

async function blockRun({ recordingId, runId, version, code, meetingId }) {
  const safe = safeTranscriptionErrorCode(code);
  const blocked = await transitionTranscription(
    recordingId,
    version,
    runId,
    [TRANSCRIPTION_STATES.RUNNING, TRANSCRIPTION_STATES.RETRYING],
    TRANSCRIPTION_STATES.BLOCKED,
    { "transcription.errorCode": safe }
  );
  const current =
    blocked || (await Recording.findById(recordingId, RUN_PROJECTION).lean());
  if (current) {
    transcriptionMetrics.observeBlocked(safe);
    emitTranscriptionStatus(String(meetingId || current.meetingId), current);
  }
  const err = new AppError(HTTP_STATUS.FORBIDDEN, "Transcription blocked.", safe);
  err.terminal = true;
  throw err;
}

// --- Main processor (BullMQ job -> durable run) -------------------------
async function processTranscriptionJob(job, { workerId } = {}) {
  const env = getEnv();
  const wid = workerId || workerIdentity();
  const data = (job && job.data) || {};
  const recordingId = data.recordingId;
  const runId = data.runId;
  const runVersion = data.runVersion;
  const { UnrecoverableError: PayloadError } = require("bullmq");
  const mongoose = require("mongoose");
  if (
    !recordingId ||
    !mongoose.Types.ObjectId.isValid(recordingId) ||
    !runId ||
    typeof runId !== "string" ||
    !Number.isInteger(runVersion)
  ) {
    // Poisoned payload (identifiers only by contract): fail without
    // retry — replays of it stay cheap.
    throw new PayloadError("Invalid transcription job payload.");
  }
  const startedAt = Date.now();
  const claim = await claimRun({
    recordingId,
    runId,
    workerId: wid,
    jobAttemptsMade: job.attemptsMade || 0,
    jobAttemptsMax: (job.opts && job.opts.attempts) || env.transcriptJobAttempts,
  });
  if (claim.stale || claim.deferred) {
    return { skipped: claim.deferred ? "deferred" : "stale" };
  }
  if (claim.early) {
    // Intent not yet committed (add beat the pending->queued write):
    // redeliver through the bounded BullMQ budget without touching
    // durable state. The queued commit lands in milliseconds; the
    // stranded-run reconciler covers wider gaps. The code below is a
    // redelivery class only and is never persisted on the run.
    transcriptionMetrics.observeRetry();
    const early = new Error("Run intent not yet committed; redelivering.");
    early.code = "PROVIDER_UNAVAILABLE";
    throw early;
  }
  let doc = claim.doc;
  const meetingId = String(doc.meetingId);
  const txVersion = () => doc.transcription.version;

  const fail = (code) => failRun({ recordingId: doc._id, runId, version: txVersion(), code, meetingId });
  const block = (code) => blockRun({ recordingId: doc._id, runId, version: txVersion(), code, meetingId });

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
    try {
      await checkTranscriptionEligibility({ meetingId: doc.meetingId, recording: doc });
    } catch (err) {
      await refresh();
      if (err && err.code === "CONSENT_BLOCKED") {
        await block("CONSENT_WITHDRAWN");
      }
      await block(safeTranscriptionErrorCode(err && err.code));
    }

    // Resolve bytes from the private locator only.
    const bucket = doc.storage.bucket;
    const key = doc.storage.key;
    const format = doc.storage.format;
    let bytes = null;
    if (env.transcriptionProvider === "mock") {
      bytes = readMockAudioBytesForTests({ bucket, key });
      if (!bytes) {
        await refresh();
        await fail("OUTPUT_MISSING");
      }
    } else if (env.transcriptionProvider === "live") {
      try {
        bytes = await readStoredObject({
          bucket,
          key,
          maxBytes: env.transcriptMaxAudioBytes,
        });
      } catch (err) {
        await refresh();
        await fail(safeTranscriptionErrorCode(err && err.code));
      }
    } else {
      await refresh();
      await block("INTEGRATION_BLOCKER");
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      await refresh();
      await fail("OUTPUT_MISSING");
    }
    if (bytes.length > env.transcriptMaxAudioBytes) {
      await refresh();
      await fail("AUDIO_TOO_LARGE");
    }
    const mime = audio.mimeForFormat(format);
    if (String(format).toLowerCase() === "mp4") {
      try {
        bytes = await audio.extractMp4Audio(bytes, env.transcriptMaxAudioBytes);
      } catch (err) {
        await refresh();
        if (err && err.code === "EXTRACTION_UNAVAILABLE") await block(err.code);
        await fail(safeTranscriptionErrorCode(err && err.code));
      }
    } else if (!audio.isDirectlySupportedMime(mime)) {
      await refresh();
      await block("EXTRACTION_UNAVAILABLE");
    }
    let parsed;
    try {
      parsed = audio.parseWav(bytes);
    } catch (err) {
      await refresh();
      await fail(safeTranscriptionErrorCode(err && err.code));
    }
    if (parsed.durationMs > env.transcriptMaxAudioMs) {
      await refresh();
      await fail("AUDIO_TOO_LONG");
    }
    const provenSilent = audio.isSilentPcm(bytes, parsed.dataOffset, parsed.dataBytes);
    const audioHash = audio.sha256Hex(bytes);

    // Run fencing snapshot: source bytes hash binds this run. A source
    // change mid-run cannot happen (bytes are in hand), but the hash
    // is persisted for audit and mock-reference lookup.
    await Recording.findOneAndUpdate(
      { _id: doc._id, "transcription.runId": runId, "transcription.version": txVersion() },
      {
        $set: {
          "transcription.source.bytes": bytes.length,
          "transcription.source.durationMs": parsed.durationMs,
          "transcription.source.audioHash": audioHash,
        },
        $inc: { "transcription.version": 1 },
      }
    ).lean();
    await refresh();

    // Chunk plan + manifest (checkpoint resume: chunks already done
    // under this runId are skipped on redelivery).
    let chunks;
    try {
      chunks = audio.planChunks(
        parsed.durationMs,
        env.transcriptChunkMs,
        env.transcriptOverlapMs,
        env.transcriptMaxChunks
      );
    } catch (err) {
      await fail(safeTranscriptionErrorCode(err && err.code));
    }
    const existingManifest = (doc.transcription.chunks || []).filter(
      (chunk) => typeof chunk.index === "number"
    );
    const manifest =
      existingManifest.length === chunks.length
        ? existingManifest
        : chunks.map((chunk) => ({ ...chunk, state: "pending", attempts: 0 }));
    if (existingManifest.length !== chunks.length) {
      await Recording.findOneAndUpdate(
        { _id: doc._id, "transcription.runId": runId, "transcription.version": txVersion() },
        {
          $set: { "transcription.chunks": manifest },
          $inc: { "transcription.version": 1 },
        }
      ).lean();
      await refresh();
    }

    const responseSchema = buildResponseSchemaS1();
    let providerFileName = doc.transcription.providerFileName || null;
    let totalSegments = 0;
    const runDeadline = startedAt + env.transcriptRunTimeoutMs;

    for (const chunk of manifest) {
      if (Date.now() > runDeadline) {
        await refresh();
        await fail("OUTPUT_INCOMPLETE");
      }
      if (chunk.state === "done") {
        const counted = await TranscriptSegment.countDocuments({
          recordingId: doc._id,
          runId,
          chunkIndex: chunk.index,
        });
        totalSegments += counted;
        continue;
      }
      await ensureNotCancelled({ recordingId: doc._id, runId, providerFileName });
      // Eligibility re-check before EVERY external call: a withdrawal
      // racing the run blocks publication even if bytes left earlier.
      try {
        await checkTranscriptionEligibility({ meetingId: doc.meetingId, recording: doc });
      } catch (err) {
        await refresh();
        await block(err && err.code === "CONSENT_BLOCKED" ? "CONSENT_WITHDRAWN" : safeTranscriptionErrorCode(err && err.code));
      }

      const chunkBytes =
        manifest.length === 1 && parsed.dataBytes === bytes.length - 44
          ? bytes
          : audio.sliceWavChunk(bytes, parsed, chunk.offsetMs, chunk.durationMs);
      const chunkHash = `${audioHash}:${chunk.index}:${chunk.offsetMs}:${chunk.durationMs}`;

      const stepStarted = Date.now();
      const onCall = async () => {
        transcriptionMetrics.observeProviderCall();
        const { takeProviderCallSlot } = require("../queues/transcriptionQueue");
        await takeProviderCallSlot();
      };
      let fileRef;
      try {
        await onCall();
        await Recording.findOneAndUpdate(
          { _id: doc._id, "transcription.runId": runId },
          { $set: { "transcription.externalInFlight": true } }
        ).lean();
        fileRef = await withStepDeadline(
          env.transcriptStepTimeoutMs,
          "PROVIDER_TIMEOUT",
          (signal) =>
            provider.uploadAudioForTranscription({
              bytes: chunkBytes,
              mimeType: "audio/wav",
              displayName: `meeting-${meetingId}-chunk-${chunk.index}`,
              signal,
              onCall: null,
            })
        );
        transcriptionMetrics.observeProviderLatency(Date.now() - stepStarted);
      } catch (err) {
        transcriptionMetrics.observeProviderLatency(Date.now() - stepStarted);
        await handleChunkError({ doc, runId, chunk, manifest, err, meetingId, refresh, fail, block, env });
      }
      if (!fileRef.mock) {
        providerFileName = fileRef.fileName;
        await Recording.findOneAndUpdate(
          { _id: doc._id, "transcription.runId": runId },
          { $set: { "transcription.providerFileName": fileRef.fileName } }
        ).lean();
      }
      const prompt = buildPromptP1({
        offsetMs: chunk.offsetMs,
        durationMs: chunk.durationMs,
        chunkIndex: chunk.index,
        chunkCount: manifest.length,
      });
      let payload;
      const genStarted = Date.now();
      try {
        await onCall();
        payload = await withStepDeadline(
          env.transcriptStepTimeoutMs,
          "PROVIDER_TIMEOUT",
          (signal) =>
            provider.transcribeChunkAudio({
              fileRef: { ...fileRef, mimeType: "audio/wav", audioHash: chunk.index === 0 ? audioHash : chunkHash, chunkAudioHash: chunkHash },
              prompt,
              responseSchema,
              signal,
              onCall: null,
            })
        );
        transcriptionMetrics.observeProviderLatency(Date.now() - genStarted);
      } catch (err) {
        if (fileRef && !fileRef.mock) {
          try {
            await provider.deleteProviderFile({ fileName: fileRef.fileName });
          } catch (_unused) {
            // Best-effort.
          }
        }
        transcriptionMetrics.observeProviderLatency(Date.now() - genStarted);
        await handleChunkError({ doc, runId, chunk, manifest, err, meetingId, refresh, fail, block, env });
      }
      if (fileRef && !fileRef.mock) {
        try {
          await provider.deleteProviderFile({ fileName: fileRef.fileName });
        } catch (_unused) {
          // Best-effort remote cleanup after use.
        }
      }
      await Recording.findOneAndUpdate(
        { _id: doc._id, "transcription.runId": runId },
        { $set: { "transcription.externalInFlight": false, "transcription.providerFileName": null } }
      ).lean();
      providerFileName = null;

      // Independent runtime validation (JSON shape proves nothing).
      let normalized;
      try {
        const validated = validateProviderPayload(payload, {
          chunkOffsetMs: chunk.offsetMs,
          chunkDurationMs: chunk.durationMs,
          sourceDurationMs: parsed.durationMs,
        });
        // Deterministic overlap reconciliation (time-based, never
        // text-based): each millisecond of output belongs to exactly
        // one chunk — the chunk whose audio extends furthest. Segments
        // starting before the previous chunk's end are dropped here
        // (the previous chunk covers them); the overlap still served
        // as acoustic context for both calls. Boundary words cut at a
        // chunk edge may lose their tail — the documented cost of
        // duplicate-free deterministic stitching.
        const outputFrom =
          chunk.index === 0
            ? 0
            : manifest[chunk.index - 1].offsetMs +
              manifest[chunk.index - 1].durationMs;
        normalized = validated.filter((segment) => segment.startMs >= outputFrom);
        // In-chunk ordering: startMs non-decreasing (overlap allowed,
        // disorder rejected).
        for (let i = 1; i < normalized.length; i += 1) {
          if (normalized[i].startMs < normalized[i - 1].startMs) {
            const err = new Error("Segments out of order.");
            err.code = "OUTPUT_MALFORMED";
            throw err;
          }
        }
      } catch (err) {
        if (!err.code) {
          err.code = "OUTPUT_MALFORMED";
        }
        await refresh();
        await handleChunkError({ doc, runId, chunk, manifest, err, meetingId, refresh, fail, block, env });
      }
      // Idempotent checkpoint: upsert by (recordingId, runId,
      // chunkIndex, ordinal); replays converge without duplicates.
      const operations = normalized.map((segment, ordinal) => ({
        updateOne: {
          filter: {
            recordingId: doc._id,
            runId,
            chunkIndex: chunk.index,
            ordinal,
          },
          update: {
            $setOnInsert: {
              meetingId: doc.meetingId,
              recordingId: doc._id,
              runId,
              runVersion,
              chunkIndex: chunk.index,
              ordinal,
              offsetMs: chunk.offsetMs,
              startMs: segment.startMs,
              endMs: segment.endMs,
              text: segment.text,
              language: segment.language,
              speakerLabel: segment.speakerLabel,
            },
          },
          upsert: true,
        },
      }));
      if (operations.length > 0) {
        await TranscriptSegment.bulkWrite(operations, { ordered: false });
      }
      totalSegments += normalized.length;
      if (totalSegments > TRANSCRIPTION_LIMITS.MAX_SEGMENTS_TOTAL_DEFAULT) {
        await refresh();
        await fail("OUTPUT_MALFORMED");
      }
      chunk.state = "done";
      chunk.attempts += 1;
      transcriptionMetrics.observeChunk();
      const marked = await Recording.findOneAndUpdate(
        {
          _id: doc._id,
          "transcription.runId": runId,
          "transcription.version": txVersion(),
        },
        {
          $set: { "transcription.chunks": manifest },
          $inc: { "transcription.version": 1 },
        },
        { new: true, projection: RUN_PROJECTION }
      ).lean();
      if (!marked) {
        // Fence moved (cancel/supersede raced us): discard staged
        // output of this run and stop — the stored run wins.
        await TranscriptSegment.deleteMany({ recordingId: doc._id, runId }).lean();
        const err = new Error("Run superseded during processing.");
        err.code = "RUN_SUPERSEDED";
        throw err;
      }
      doc = marked;
    }

    // Final validation before atomic publish.
    await ensureNotCancelled({ recordingId: doc._id, runId, providerFileName });
    try {
      await checkTranscriptionEligibility({ meetingId: doc.meetingId, recording: doc });
    } catch (err) {
      await refresh();
      await block(err && err.code === "CONSENT_BLOCKED" ? "CONSENT_WITHDRAWN" : safeTranscriptionErrorCode(err && err.code));
    }
    const doneChunks = manifest.filter((chunk) => chunk.state === "done").length;
    if (doneChunks !== manifest.length) {
      await refresh();
      await fail("OUTPUT_INCOMPLETE");
    }
    if (totalSegments === 0 && !provenSilent) {
      // Non-silent audio with zero segments is incomplete, not empty.
      await refresh();
      await fail("OUTPUT_INCOMPLETE");
    }
    if (totalSegments > TRANSCRIPTION_LIMITS.MAX_SEGMENTS_TOTAL_DEFAULT) {
      await refresh();
      await fail("OUTPUT_MALFORMED");
    }
    const published = await transitionTranscription(
      doc._id,
      txVersion(),
      runId,
      [TRANSCRIPTION_STATES.RUNNING, TRANSCRIPTION_STATES.RETRYING],
      TRANSCRIPTION_STATES.COMPLETE,
      {
        "transcription.publishedRunVersion": runVersion,
        "transcription.publishedAt": new Date(),
        "transcription.segmentCount": totalSegments,
        "transcription.completedAt": new Date(),
        "transcription.errorCode": null,
        "transcription.leaseUntil": null,
        "transcription.externalInFlight": false,
      }
    );
    const current =
      published || (await Recording.findById(doc._id, RUN_PROJECTION).lean());
    // Publish verification: only an actual complete fence-holder may
    // report success. A lost fence (cancel/supersede raced us) is a
    // skip, never a claimed completion.
    if (
      published &&
      current &&
      current.transcription &&
      current.transcription.runId === runId &&
      current.transcription.state === TRANSCRIPTION_STATES.COMPLETE &&
      current.transcription.publishedRunVersion === runVersion
    ) {
      transcriptionMetrics.observeComplete();
      emitTranscriptionStatus(meetingId, current);
      return { complete: true, segments: totalSegments, silent: provenSilent };
    }
    // Publish lost the fence (cancel/supersede): staged output is
    // already fenced out of reads; report without emitting ready.
    return { skipped: "superseded" };
  } catch (err) {
    // Terminal outcomes (failed/blocked/cancelled/superseded) must not
    // burn BullMQ retries: the durable run already records them, and a
    // redelivery would only re-read a terminal fence. UnrecoverableError
    // (BullMQ v6) stops redelivery without error-state loss.
    const { UnrecoverableError } = require("bullmq");
    if (err && (err.terminal || err.cancelled)) {
      const done = new UnrecoverableError(err.message);
      done.code = err.code;
      throw done;
    }
    if (err && err.code === "RUN_SUPERSEDED") {
      return { skipped: "superseded" };
    }
    // Retryable inside the bounded BullMQ budget: mark retrying and
    // rethrow so the queue redelivers; the claim fence + chunk
    // checkpoints make redelivery converge.
    const code = safeTranscriptionErrorCode(err && err.code);
    if (isRetryableTranscriptionError(code)) {
    const current = await readCurrentRun(recordingId, runId);
    if (current && !isTerminalTranscriptionState(current.transcription.state)) {
      await transitionTranscription(
        recordingId,
        current.transcription.version,
        runId,
        [TRANSCRIPTION_STATES.RUNNING, TRANSCRIPTION_STATES.RETRYING],
        TRANSCRIPTION_STATES.RETRYING,
        { "transcription.errorCode": code }
      );
      transcriptionMetrics.observeRetry();
    }
      const retryable = new Error(err && err.message ? err.message : "Transient failure.");
      retryable.code = code;
      throw retryable;
    }
    const current = await readCurrentRun(recordingId, runId);
    if (current && !isTerminalTranscriptionState(current.transcription.state)) {
      await transitionTranscription(
        recordingId,
        current.transcription.version,
        runId,
        [TRANSCRIPTION_STATES.RUNNING, TRANSCRIPTION_STATES.RETRYING],
        TRANSCRIPTION_STATES.FAILED,
        { "transcription.errorCode": code }
      );
      transcriptionMetrics.observeFailed(code);
      emitTranscriptionStatus(meetingId, await readCurrentRun(recordingId, runId));
    }
    const { UnrecoverableError: TerminalError } = require("bullmq");
    const terminal = new TerminalError(err && err.message ? err.message : "Transcription failed.");
    terminal.code = code;
    throw terminal;
  }
}

// Per-chunk error routing: retryable -> mark attempts and rethrow for
// BullMQ redelivery; terminal-class -> fail/block the run now.
async function handleChunkError({ doc, runId, chunk, manifest, err, meetingId, refresh, fail, block, env }) {
  void manifest;
  void env;
  const code = safeTranscriptionErrorCode(err && err.code);
  chunk.attempts += 1;
  if (err && err.code === "CANCELLED") {
    throw err;
  }
  if (
    code === "CONSENT_BLOCKED" ||
    code === "INTEGRATION_BLOCKER" ||
    code === "EXTRACTION_UNAVAILABLE" ||
    code === "PROVIDER_AUTH_FAILED" ||
    code === "PROVIDER_QUOTA_EXHAUSTED" ||
    code === "OUTPUT_SAFETY_BLOCKED" ||
    code === "OUTPUT_MALFORMED" ||
    code === "OUTPUT_TRUNCATED"
  ) {
    await refresh();
    if (code === "CONSENT_BLOCKED") {
      await block("CONSENT_WITHDRAWN");
    } else if (
      code === "INTEGRATION_BLOCKER" ||
      code === "EXTRACTION_UNAVAILABLE"
    ) {
      await block(code);
    } else {
      await fail(code);
    }
  }
  // Retryable (429/5xx/network/timeout/schema-transient): checkpoint
  // attempts on the manifest, then rethrow for queue redelivery.
  try {
    const current = await Recording.findById(doc._id, RUN_PROJECTION).lean();
    if (current && current.transcription && current.transcription.runId === runId) {
      const next = (current.transcription.chunks || []).map((entry, index) =>
        index === chunk.index
          ? { ...entry, attempts: (entry.attempts || 0) + 1 }
          : entry
      );
      await Recording.findOneAndUpdate(
        { _id: doc._id, "transcription.runId": runId },
        { $set: { "transcription.chunks": next } }
      ).lean();
    }
  } catch (_unused) {
    // Checkpoint failure must not mask the original error.
  }
  const retryable = new Error(err && err.message ? err.message : "Chunk failed transiently.");
  retryable.code = code;
  throw retryable;
}

module.exports = { processTranscriptionJob, claimRun, workerIdentity };
