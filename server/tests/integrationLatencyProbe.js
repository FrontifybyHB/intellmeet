"use strict";

// Bounded post-meeting read latency probe (local MongoDB, mock data —
// NOT a capacity/SLA claim). Seeds many rooms plus one hot room, then
// measures join/history/detail/chat-ack/chat-history/transcript/
// intelligence/action-item reads: p50/p95/p99, throughput, RSS delta,
// and explain() plans for the two NEW Phase 6 queries. Never run
// against production.
//
// Usage:
//   MONGODB_URI=mongodb://127.0.0.1:27017/intellmeet-latency \
//   node tests/integrationLatencyProbe.js [rooms]
//
// Defaults to 50 rooms. Requires local MongoDB (no Redis needed —
// HTTP reads only). Provisional local targets (dev machine, warm):
// listed reads p95 < 100ms, chat-ack p95 < 50ms. Provider job
// completion and media latency are reported separately, never here.

const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");

const ROOMS = Math.min(
  200,
  Math.max(5, Number(process.argv[2] || process.env.LATENCY_ROOMS || 50))
);
const REPS = 20;

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-latency";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = process.env.JWT_SECRET || "latency-secret-do-not-use";
process.env.LIVEKIT_URL = "wss://livekit.latency.example.com";
process.env.LIVEKIT_API_KEY = "lat-key";
process.env.LIVEKIT_API_SECRET = "lat-secret-do-not-use";
process.env.RECORDING_PROVIDER = "mock";
process.env.RECORDING_OUTPUT_BUCKET = "lat-bucket";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const Recording = require("../src/models/Recording");
const TranscriptSegment = require("../src/models/TranscriptSegment");
const MeetingIntelligence = require("../src/models/MeetingIntelligence");
const ActionItem = require("../src/models/ActionItem");
const ChatMessage = require("../src/models/ChatMessage");
const User = require("../src/models/User");

function signToken(sub) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub, purpose: "access", iss: "intellmeet", aud: "intellmeet-app", ver: 0, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p95: Math.round(percentile(sorted, 95) * 100) / 100,
    p99: Math.round(percentile(sorted, 99) * 100) / 100,
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    Meeting.syncIndexes(),
    MeetingParticipant.syncIndexes(),
    Recording.syncIndexes(),
    TranscriptSegment.syncIndexes(),
    MeetingIntelligence.syncIndexes(),
    ActionItem.syncIndexes(),
    ChatMessage.syncIndexes(),
  ]);
  await Promise.all([
    Meeting.deleteMany({}),
    MeetingParticipant.deleteMany({}),
    Recording.deleteMany({}),
    TranscriptSegment.deleteMany({}),
    MeetingIntelligence.deleteMany({}),
    ActionItem.deleteMany({}),
    ChatMessage.deleteMany({}),
  ]);

  const hostId = new mongoose.Types.ObjectId();
  await User.updateOne({ _id: hostId }, { $setOnInsert: { name: "load", email: `load-${String(hostId)}@example.com`, role: "user", status: "active", authVersion: 0 } }, { upsert: true });
  const hostToken = signToken(hostId.toString());
  let hot = null;
  for (let i = 0; i < ROOMS; i += 1) {
    const meeting = await Meeting.create({
      title: `lat-${i}`,
      hostId,
      status: i % 2 === 0 ? "ended" : "live",
    });
    if (i === 0) {
      hot = meeting;
    }
  }
  // Live room for join/chat-ack probes: post-end join and live-chat
  // history are correctly denied (403), so latency for those paths is
  // measured here, not against the ended hot room.
  const liveRoom = await Meeting.create({ title: "lat-live", hostId, status: "live" });
  const liveId = liveRoom._id.toString();
  const hotId = hot._id.toString();
  // Hot room: 200 chat messages, ready recording, 100 segments,
  // complete intelligence with 10 suggestions.
  const bulk = [];
  for (let i = 0; i < 200; i += 1) {
    bulk.push({
      meetingId: hot._id,
      senderId: hostId,
      clientMessageId: `lat-${i}`,
      text: `latency message number ${i}`,
    });
  }
  await ChatMessage.insertMany(bulk, { ordered: false });
  await ChatMessage.insertMany(
    Array.from({ length: 20 }, (_, i) => ({
      meetingId: liveRoom._id,
      senderId: hostId,
      clientMessageId: `lat-live-${i}`,
      text: `live message ${i}`,
    })),
    { ordered: false }
  );
  const recording = await Recording.create({
    meetingId: hot._id,
    sessionId: `meeting_${hotId}`,
    requesterId: hostId,
    state: "ready",
    version: 1,
    storage: { bucket: "lat-bucket", key: `recordings/${hotId}/run.wav`, format: "wav" },
    output: { sizeBytes: 1024, durationMs: 9000 },
    transcription: { state: "complete", runId: "tr_lat", runVersion: 1, publishedRunVersion: 1, segmentCount: 100 },
  });
  const segs = [];
  for (let i = 0; i < 100; i += 1) {
    segs.push({
      meetingId: hot._id,
      recordingId: recording._id,
      runId: "tr_lat",
      runVersion: 1,
      chunkIndex: Math.floor(i / 50),
      ordinal: i % 50,
      offsetMs: 0,
      startMs: i * 1000,
      endMs: i * 1000 + 900,
      text: `segment ${i}`,
    });
  }
  await TranscriptSegment.insertMany(segs, { ordered: false });
  const intel = await MeetingIntelligence.create({
    meetingId: hot._id,
    recordingId: recording._id,
    sourceTranscriptRunId: "tr_lat",
    sourceTranscriptRunVersion: 1,
    sourceSegmentCount: 100,
    runId: "ix_lat",
    runVersion: 1,
    version: 1,
    state: "complete",
    pipelineVersion: "i1",
    model: "m",
    promptVersion: "p1",
    schemaVersion: "s1",
    contextVersion: "c1",
    consentNoticeVersion: "v1",
    summaryBullets: [{ text: "hot summary", evidence: { segmentIds: ["0:0"], startMs: 0, endMs: 900 } }],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    publishedAt: new Date(),
    enqueuedAt: new Date(),
    updatedAt: new Date(),
  });
  const items = [];
  for (let i = 0; i < 10; i += 1) {
    items.push({
      meetingId: hot._id,
      recordingId: recording._id,
      intelligenceId: intel._id,
      intelligenceRunId: "ix_lat",
      intelligenceRunVersion: 1,
      suggestionKey: `lat-key-${i}`,
      titleProposed: `lat task ${i}`,
      evidenceSegmentIds: ["0:0"],
      state: "proposed",
      version: 0,
      taskLink: { status: "blocked", reason: "NOT_APPROVED" },
    });
  }
  await ActionItem.insertMany(items, { ordered: false });

  const httpServer = http.createServer(app);
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

async function timed(method, path, token, body) {
    const started = process.hrtime.bigint();
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...authHeaders(token),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    await res.text();
    return { status: res.status, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  // Warm once (cold JIT/pool behavior excluded from the headline).
  await timed("GET", "/api/meetings?limit=20", hostToken);
  await timed("GET", `/api/meetings/${hotId}`, hostToken);

  const lat = { join: [], history: [], detail: [], chatHistory: [], transcript: [], intelligence: [], actions: [] };
  let errors = 0;
  const t0 = Date.now();
  for (let r = 0; r < REPS; r += 1) {
    const j = await timed("POST", `/api/meetings/${liveId}/join`, hostToken);
    lat.join.push(j.ms);
    if (j.status !== 200) {
      errors += 1;
    }
    const h = await timed("GET", "/api/meetings?limit=20", hostToken);
    lat.history.push(h.ms);
    if (h.status !== 200) {
      errors += 1;
    }
    const d = await timed("GET", `/api/meetings/${hotId}`, hostToken);
    lat.detail.push(d.ms);
    if (d.status !== 200) {
      errors += 1;
    }
    const c = await timed("GET", `/api/meetings/${liveId}/messages?limit=50`, hostToken);
    lat.chatHistory.push(c.ms);
    if (c.status !== 200) {
      errors += 1;
    }
    const t = await timed("GET", `/api/meetings/${hotId}/recordings/${recording._id}/transcript?limit=50`, hostToken);
    lat.transcript.push(t.ms);
    if (t.status !== 200) {
      errors += 1;
    }
    const ix = await timed("GET", `/api/meetings/${hotId}/recordings/${recording._id}/intelligence`, hostToken);
    lat.intelligence.push(ix.ms);
    if (ix.status !== 200) {
      errors += 1;
    }
    const ax = await timed("GET", `/api/meetings/${hotId}/recordings/${recording._id}/action-items?limit=50`, hostToken);
    lat.actions.push(ax.ms);
    if (ax.status !== 200) {
      errors += 1;
    }
  }
  const wallMs = Date.now() - t0;
  const total = REPS * 7;
  const mem1 = process.memoryUsage();

  // Explain the two NEW Phase 6 queries (index proof, not timing).
  const memberProbe = await MeetingParticipant.findOne({ userId: hostId }).lean();
  void memberProbe;
  const historyExplain = await Meeting.find(
    { $or: [{ hostId }, { _id: { $in: [hot._id] } }] },
    { title: 1 }
  )
    .sort({ _id: -1 })
    .limit(21)
    .explain("executionStats");
  const participantExplain = await MeetingParticipant.find({ userId: hostId }, { meetingId: 1 })
    .sort({ _id: -1 })
    .limit(21)
    .explain("executionStats");
  function planSummary(explain) {
    const stats = explain.executionStats || {};
    const stage = (explain.queryPlanner || {}).winningPlan || {};
    return {
      nReturned: stats.nReturned,
      totalDocsExamined: stats.totalDocsExamined,
      totalKeysExamined: stats.totalKeysExamined,
      winningStage: JSON.stringify(stage).slice(0, 200),
    };
  }

  console.log(
    JSON.stringify(
      {
        rooms: ROOMS,
        hotRoomMessages: 200,
        hotRoomSegments: 100,
        reps: REPS,
        wallMs,
        throughputPerMin: Math.round((total / Math.max(1, wallMs)) * 60000),
        errors,
        joinMs: summarize(lat.join),
        historyMs: summarize(lat.history),
        detailMs: summarize(lat.detail),
        chatHistoryMs: summarize(lat.chatHistory),
        transcriptMs: summarize(lat.transcript),
        intelligenceMs: summarize(lat.intelligence),
        actionItemsMs: summarize(lat.actions),
        historyPlan: planSummary(historyExplain),
        participantPlan: planSummary(participantExplain),
        rssDeltaMb: Math.round((mem1.rss - mem0.rss) / 1024 / 1024),
      },
      null,
      2
    )
  );

  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await mongoose.disconnect();
  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`latency probe failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
