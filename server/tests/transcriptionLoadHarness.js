"use strict";

// Bounded synthetic transcription load/failure harness (mock provider
// only — app orchestration throughput, NOT Google quota/cost/quality).
// Drives consent -> ready -> enqueue -> worker -> complete across many
// recordings with latency fault injection; prints jobs/min, queue
// wait/age, p50/p95/p99, retries, RSS/temp-disk deltas, and cleanup
// backlog. Never run against production or the live provider.
//
// Usage:
//   MONGODB_URI=mongodb://127.0.0.1:27017/intellmeet-tx-load \
//   REDIS_URL=redis://127.0.0.1:6379/15 \
//   node tests/transcriptionLoadHarness.js [recordings]
//
// Defaults to 30 recordings. Requires local MongoDB + Redis.

const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");

const RECORDINGS = Math.min(
  200,
  Math.max(1, Number(process.argv[2] || process.env.TRANSCRIPT_LOAD_RECORDINGS || 30))
);

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-tx-load";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = process.env.JWT_SECRET || "load-test-secret-do-not-use";
process.env.LIVEKIT_URL = "wss://livekit.load.example.com";
process.env.LIVEKIT_API_KEY = "load-key";
process.env.LIVEKIT_API_SECRET = "load-secret-do-not-use";
process.env.RECORDING_PROVIDER = "mock";
process.env.RECORDING_OUTPUT_BUCKET = "load-bucket";
process.env.RECORDING_NOTICE_VERSION = "v1";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379/15";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const { attachMeetingSockets } = require("../src/sockets/meetingSockets");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const Recording = require("../src/models/Recording");
const RecordingConsent = require("../src/models/RecordingConsent");
const TranscriptSegment = require("../src/models/TranscriptSegment");
const WebhookEvent = require("../src/models/WebhookEvent");
const recordingProvider = require("../src/services/recordingProvider");
const geminiProvider = require("../src/services/geminiTranscriptionProvider");
const transcriptionAudio = require("../src/services/transcriptionAudio");
const { startTranscriptionWorker, stopTranscriptionWorker } = require("../src/queues/transcriptionWorker");
const transcriptionQueue = require("../src/queues/transcriptionQueue");

function signToken(sub, secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    Meeting.syncIndexes(),
    MeetingParticipant.syncIndexes(),
    Recording.syncIndexes(),
    RecordingConsent.syncIndexes(),
    TranscriptSegment.syncIndexes(),
    WebhookEvent.syncIndexes(),
  ]);
  await Promise.all([
    Meeting.deleteMany({}),
    MeetingParticipant.deleteMany({}),
    Recording.deleteMany({}),
    RecordingConsent.deleteMany({}),
    TranscriptSegment.deleteMany({}),
    WebhookEvent.deleteMany({}),
  ]);
  const redis = transcriptionQueue.getConnection();
  await redis.flushdb();

  const httpServer = http.createServer(app);
  const sockets = attachMeetingSockets(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const mem0 = process.memoryUsage();

  async function api(method, path, token, body) {
    const started = process.hrtime.bigint();
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_unused) {
      json = null;
    }
    return { status: res.status, json, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  // One shared worker (concurrency from env, default 2). Every third
  // recording gets provider latency to exercise queue wait/age.
  await startTranscriptionWorker();

  const lat = { enqueue: [], run: [] };
  let errors = 0;
  let injected = 0;
  const t0 = Date.now();
  const completions = [];
  for (let i = 0; i < RECORDINGS; i += 1) {
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    const meeting = await Meeting.create({ title: `tx-load-${i}`, hostId, status: "ended" });
    await MeetingParticipant.create({ meetingId: meeting._id, userId: memberId, status: "admitted" });
    for (const uid of [hostId, memberId]) {
      await RecordingConsent.create({
        meetingId: meeting._id,
        userId: uid,
        noticeVersion: "v1",
        recording: "approved",
        aiTransfer: "approved",
      });
    }
    const id = meeting._id.toString();
    const key = `recordings/${id}/run.wav`;
    const bytes = transcriptionAudio.synthesizeWav({
      sampleRate: 16000,
      parts: [{ freqHz: 440, ms: 3000 }, { freqHz: 0, ms: 500 }, { freqHz: 660, ms: 3000 }],
    });
    recordingProvider.mockPutAudioBytesForTests({ bucket: "load-bucket", key, bytes, durationMs: 6500 });
    const recording = await Recording.create({
      meetingId: meeting._id,
      sessionId: `meeting_${id}`,
      requesterId: hostId,
      state: "ready",
      version: 2,
      storage: { bucket: "load-bucket", key, format: "wav" },
      output: { sizeBytes: bytes.length, durationMs: 6500 },
    });
    geminiProvider.mockRegisterReference(transcriptionAudio.sha256Hex(bytes), {
      segments: [{ startMs: 0, endMs: 2000, text: `load segment ${i}` }],
    });
    if (i % 3 === 2) {
      geminiProvider.mockBehavior.latencyMs = 150;
      injected += 1;
    } else {
      geminiProvider.mockBehavior.latencyMs = 0;
    }
    const hostToken = signToken(hostId.toString(), process.env.JWT_SECRET);
    const enq = await api("POST", `/api/meetings/${id}/recordings/${recording._id}/transcription`, hostToken);
    lat.enqueue.push(enq.ms);
    if (enq.status !== 200) {
      errors += 1;
      continue;
    }
    completions.push({ recordingId: recording._id, enqueuedAt: Date.now() });
  }

  // Wait for the worker to drain (bounded).
  const deadline = Date.now() + 120000;
  let complete = 0;
  let failed = 0;
  while (Date.now() < deadline) {
    const counts = await Recording.aggregate([
      { $match: { "transcription.state": { $in: ["complete", "failed", "blocked", "cancelled"] } } },
      { $group: { _id: "$transcription.state", n: { $sum: 1 } } },
    ]);
    complete = 0;
    failed = 0;
    for (const row of counts) {
      if (row._id === "complete") {
        complete = row.n;
      } else {
        failed += row.n;
      }
    }
    if (complete + failed >= RECORDINGS) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const wallMs = Date.now() - t0;
  // Per-run latency approximated from enqueuedAt to completedAt.
  const done = await Recording.find({ "transcription.state": "complete" }, { transcription: 1 }).lean();
  for (const row of done) {
    const tx = row.transcription || {};
    if (tx.enqueuedAt && tx.completedAt) {
      lat.run.push(new Date(tx.completedAt).getTime() - new Date(tx.enqueuedAt).getTime());
    }
  }
  for (const k of Object.keys(lat)) {
    lat[k].sort((a, b) => a - b);
  }
  const stuck = await Recording.countDocuments({
    "transcription.state": { $in: ["pending_enqueue", "queued", "running", "retrying"] },
  });
  const segments = await TranscriptSegment.countDocuments({});
  const mem1 = process.memoryUsage();
  const waiting = await transcriptionQueue.getWaitingCount().catch(() => -1);
  console.log(
    JSON.stringify(
      {
        recordings: RECORDINGS,
        injectedLatencyRuns: injected,
        wallMs,
        jobsPerMin: Math.round((RECORDINGS / Math.max(1, wallMs)) * 60000),
        errors,
        complete,
        failed,
        recoveryBacklog: stuck,
        segments,
        queueWaiting: waiting,
        enqueueMs: { p50: percentile(lat.enqueue, 50), p95: percentile(lat.enqueue, 95), p99: percentile(lat.enqueue, 99) },
        runMs: { p50: percentile(lat.run, 50), p95: percentile(lat.run, 95), p99: percentile(lat.run, 99) },
        rssDeltaMb: Math.round((mem1.rss - mem0.rss) / 1024 / 1024),
      },
      null,
      2
    )
  );

  await stopTranscriptionWorker();
  await transcriptionQueue.closeForTests();
  await sockets.close();
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await mongoose.disconnect();
  if (errors > 0 || failed > 0 || stuck > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`load probe failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
