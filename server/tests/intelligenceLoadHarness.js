"use strict";

// Bounded synthetic intelligence load harness (mock provider only —
// app orchestration throughput, NOT Google quota/cost/quality).
// Drives consent -> ready transcript -> enqueue -> worker -> complete
// across many meetings plus one long multi-window source with latency
// fault injection; prints jobs/min, queue wait, p50/p95/p99, retries,
// provider calls, RSS delta, and recovery backlog. Never run against
// production or the live provider.
//
// Usage:
//   MONGODB_URI=mongodb://127.0.0.1:27017/intellmeet-ix-load \
//   REDIS_URL=redis://127.0.0.1:6379/15 \
//   node tests/intelligenceLoadHarness.js [meetings]
//
// Defaults to 20 meetings + 1 long source. Requires local MongoDB +
// Redis. Provisional budgets (measured on the dev machine at run
// time, not a scalability claim): all enqueues accepted, zero failed,
// zero backlog at drain.

const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");

const MEETINGS = Math.min(
  100,
  Math.max(1, Number(process.argv[2] || process.env.INTEL_LOAD_MEETINGS || 20))
);

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-ix-load";
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
process.env.INTELLIGENCE_PROVIDER = "mock";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379/15";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const { attachMeetingSockets } = require("../src/sockets/meetingSockets");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const User = require("../src/models/User");
const Recording = require("../src/models/Recording");
const RecordingConsent = require("../src/models/RecordingConsent");
const TranscriptSegment = require("../src/models/TranscriptSegment");
const MeetingIntelligence = require("../src/models/MeetingIntelligence");
const ActionItem = require("../src/models/ActionItem");
const geminiIntel = require("../src/services/geminiIntelligenceProvider");
const { startIntelligenceWorker, stopIntelligenceWorker } = require("../src/queues/intelligenceWorker");
const intelligenceQueue = require("../src/queues/intelligenceQueue");
const intelligenceMetrics = require("../src/utils/intelligenceMetrics");

function signToken(sub, secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub, purpose: "access", iss: "intellmeet", aud: "intellmeet-app", ver: 0, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
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

async function seedTranscript({ meetingId, recordingId, texts }) {
  for (let i = 0; i < texts.length; i += 1) {
    await TranscriptSegment.create({
      meetingId,
      recordingId,
      runId: "tr_pin",
      runVersion: 3,
      chunkIndex: Math.floor(i / 50),
      ordinal: i % 50,
      offsetMs: 0,
      startMs: i * 2000,
      endMs: i * 2000 + 1800,
      text: texts[i],
      language: i % 3 === 0 ? "hi" : "en",
      speakerLabel: `speaker_${(i % 2) + 1}`,
    });
  }
}

function cannedFor(ids) {
  return {
    summaryBullets: [{ text: `Covered ${ids.length} segments.`, evidence: { segmentIds: ids.slice(0, 2) } }],
    decisions: [{ text: "Proceed as discussed.", evidence: { segmentIds: [ids[0]] } }],
    blockers: [],
    unresolvedQuestions: [],
    suggestedActions: [{ title: "Follow up", evidence: { segmentIds: [ids[ids.length - 1]] } }],
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    Meeting.syncIndexes(),
    MeetingParticipant.syncIndexes(),
    Recording.syncIndexes(),
    RecordingConsent.syncIndexes(),
    TranscriptSegment.syncIndexes(),
    MeetingIntelligence.syncIndexes(),
    ActionItem.syncIndexes(),
  ]);
  await Promise.all([
    Meeting.deleteMany({}),
    MeetingParticipant.deleteMany({}),
    Recording.deleteMany({}),
    RecordingConsent.deleteMany({}),
    TranscriptSegment.deleteMany({}),
    MeetingIntelligence.deleteMany({}),
    ActionItem.deleteMany({}),
  ]);
  const redis = intelligenceQueue.getConnection();
  await redis.flushdb();

  const httpServer = http.createServer(app);
  const sockets = attachMeetingSockets(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const mem0 = process.memoryUsage();

  // Cookie-only credentials with the login-context-bound CSRF value.
function csrfFor(token) {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(`csrf:${payload.jti || "anonymous"}`)
    .digest("base64url");
}

function authHeaders(token) {
  if (!token) {
    return {};
  }
  const csrf = csrfFor(token);
  return { cookie: `im_at=${token}; im_csrf=${csrf}`, "x-csrf-token": csrf };
}

async function api(method, path, token, body) {
    const started = process.hrtime.bigint();
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...authHeaders(token),
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

  await startIntelligenceWorker();

  const lat = { enqueue: [], run: [] };
  let errors = 0;
  let injected = 0;
  const t0 = Date.now();
  for (let i = 0; i < MEETINGS; i += 1) {
    const long = i === MEETINGS - 1;
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    for (const uid of [hostId, memberId]) { await User.updateOne({ _id: uid }, { $setOnInsert: { name: "load", email: `load-${String(uid)}@example.com`, role: "user", status: "active", authVersion: 0 } }, { upsert: true }); }
    const meeting = await Meeting.create({ title: `ix-load-${i}`, hostId, status: "ended" });
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
    const texts = long
      ? Array.from({ length: 120 }, (_, k) => `Long meeting utterance ${k}: shaamil team ne faisla kiya ke release Monday ko hogi.`)
      : [`load decision ${i}: ship it.`, `load follow-up ${i}: notes pending.`];
    const recording = await Recording.create({
      meetingId: meeting._id,
      sessionId: `meeting_${id}`,
      requesterId: hostId,
      state: "ready",
      version: 2,
      storage: { bucket: "load-bucket", key: `recordings/${id}/run.wav`, format: "wav" },
      output: { sizeBytes: 1024, durationMs: 9000 },
      transcription: {
        state: "complete",
        runId: "tr_pin",
        runVersion: 3,
        version: 2,
        pipelineVersion: "t1",
        model: "gemini-2.0-flash",
        promptVersion: "p1",
        schemaVersion: "s1",
        publishedRunVersion: 3,
        publishedAt: new Date(),
        segmentCount: texts.length,
      },
    });
    await seedTranscript({ meetingId: meeting._id, recordingId: recording._id, texts });
    const ids = texts.map((_, k) => `${Math.floor(k / 50)}:${k % 50}`);
    geminiIntel.mockRegisterIntelligenceResponse("default", cannedFor(ids.slice(0, 2)));
    if (long) {
      // Multi-window path (map + reconcile) with latency injection.
      geminiIntel.mockBehavior.latencyMs = 150;
      injected += 1;
      const { getEnv } = require("../src/config/env");
      void getEnv;
    } else {
      geminiIntel.mockBehavior.latencyMs = 0;
    }
    const hostToken = signToken(hostId.toString(), process.env.JWT_SECRET);
    const enq = await api("POST", `/api/meetings/${id}/recordings/${recording._id}/intelligence`, hostToken);
    lat.enqueue.push(enq.ms);
    if (enq.status !== 200) {
      errors += 1;
    }
  }

  const deadline = Date.now() + 120000;
  let complete = 0;
  let failed = 0;
  while (Date.now() < deadline) {
    const counts = await MeetingIntelligence.aggregate([
      { $match: { state: { $in: ["complete", "failed", "blocked", "cancelled"] } } },
      { $group: { _id: "$state", n: { $sum: 1 } } },
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
    if (complete + failed >= MEETINGS) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const wallMs = Date.now() - t0;
  const done = await MeetingIntelligence.find({ state: "complete" }, { enqueuedAt: 1, completedAt: 1 }).lean();
  for (const row of done) {
    if (row.enqueuedAt && row.completedAt) {
      lat.run.push(new Date(row.completedAt).getTime() - new Date(row.enqueuedAt).getTime());
    }
  }
  for (const k of Object.keys(lat)) {
    lat[k].sort((a, b) => a - b);
  }
  const stuck = await MeetingIntelligence.countDocuments({
    state: { $in: ["pending_enqueue", "queued", "running", "retrying"] },
  });
  const suggestions = await ActionItem.countDocuments({});
  const mem1 = process.memoryUsage();
  const waiting = await intelligenceQueue.getWaitingCount().catch(() => -1);
  const metrics = intelligenceMetrics.snapshot();
  console.log(
    JSON.stringify(
      {
        meetings: MEETINGS,
        injectedLatencyRuns: injected,
        wallMs,
        jobsPerMin: Math.round((MEETINGS / Math.max(1, wallMs)) * 60000),
        errors,
        complete,
        failed,
        recoveryBacklog: stuck,
        suggestions,
        queueWaiting: waiting,
        providerCalls: metrics.providerCalls,
        retries: metrics.retries,
        enqueueMs: { p50: percentile(lat.enqueue, 50), p95: percentile(lat.enqueue, 95), p99: percentile(lat.enqueue, 99) },
        runMs: { p50: percentile(lat.run, 50), p95: percentile(lat.run, 95), p99: percentile(lat.run, 99) },
        rssDeltaMb: Math.round((mem1.rss - mem0.rss) / 1024 / 1024),
      },
      null,
      2
    )
  );

  await stopIntelligenceWorker();
  await intelligenceQueue.closeForTests();
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
