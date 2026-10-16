"use strict";

// Bounded synthetic lifecycle/webhook load probe for Phase 3.
// Drives consent -> start -> egress webhook -> stop -> end across many
// meetings against the MOCK provider only (control-plane throughput,
// NOT media/Egress capacity). Prints latency percentiles, errors,
// and recovery backlog. Never run against production or real Egress.
//
// Usage:
//   MONGODB_URI=mongodb://127.0.0.1:27017/intellmeet-load node tests/recordingLoadHarness.js [meetings]
// Defaults to 50 meetings. Requires a local MongoDB.

const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");

const MEETINGS = Math.min(
  500,
  Math.max(1, Number(process.argv[2] || process.env.RECORDING_LOAD_MEETINGS || 50))
);

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-load";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = process.env.JWT_SECRET || "load-test-secret-do-not-use";
process.env.LIVEKIT_URL = "wss://livekit.load.example.com";
process.env.LIVEKIT_API_KEY = "load-key";
process.env.LIVEKIT_API_SECRET = "load-secret-do-not-use";
process.env.RECORDING_PROVIDER = "mock";
process.env.RECORDING_OUTPUT_BUCKET = "load-bucket";
process.env.RECORDING_NOTICE_VERSION = "v1";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const { attachMeetingSockets } = require("../src/sockets/meetingSockets");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const User = require("../src/models/User");
const Recording = require("../src/models/Recording");
const RecordingConsent = require("../src/models/RecordingConsent");
const WebhookEvent = require("../src/models/WebhookEvent");
const provider = require("../src/services/recordingProvider");

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

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    Meeting.syncIndexes(),
    MeetingParticipant.syncIndexes(),
    Recording.syncIndexes(),
    RecordingConsent.syncIndexes(),
    WebhookEvent.syncIndexes(),
  ]);
  await Promise.all([
    Meeting.deleteMany({}),
    MeetingParticipant.deleteMany({}),
    Recording.deleteMany({}),
    RecordingConsent.deleteMany({}),
    WebhookEvent.deleteMany({}),
  ]);

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
    await res.text();
    return { status: res.status, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  async function webhook(event) {
    const raw = Buffer.from(JSON.stringify(event), "utf8");
    const digest = crypto.createHash("sha256").update(raw).digest("hex");
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: process.env.LIVEKIT_API_KEY, sha256: digest, exp: Math.floor(Date.now() / 1000) + 300 })
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", process.env.LIVEKIT_API_SECRET).update(`${header}.${payload}`).digest("base64url");
    const started = process.hrtime.bigint();
    const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
      method: "POST",
      headers: { "content-type": "application/webhook+json", authorization: `${header}.${payload}.${sig}` },
      body: raw,
    });
    await res.text();
    return { status: res.status, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  const lat = { start: [], hook: [], end: [] };
  let errors = 0;
  const t0 = Date.now();
  for (let i = 0; i < MEETINGS; i += 1) {
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    for (const uid of [hostId, memberId]) { await User.updateOne({ _id: uid }, { $setOnInsert: { name: "load", email: `load-${String(uid)}@example.com`, role: "user", status: "active", authVersion: 0 } }, { upsert: true }); }
    const meeting = await Meeting.create({ title: `load-${i}`, hostId, status: "live" });
    await MeetingParticipant.create({ meetingId: meeting._id, userId: memberId, status: "admitted" });
    const id = meeting._id.toString();
    const hostToken = signToken(hostId.toString(), process.env.JWT_SECRET);
    const memberToken = signToken(memberId.toString(), process.env.JWT_SECRET);
    await api("POST", `/api/meetings/${id}/recording-consent`, hostToken, { decision: "approved", noticeVersion: "v1" });
    await api("POST", `/api/meetings/${id}/recording-consent`, memberToken, { decision: "approved", noticeVersion: "v1" });
    const s = await api("POST", `/api/meetings/${id}/recordings/start`, hostToken);
    lat.start.push(s.ms);
    if (s.status !== 200) {
      errors += 1;
      continue;
    }
    const rec = await Recording.findOne({ meetingId: meeting._id }).lean();
    provider.mockPutTestObject({ bucket: "load-bucket", key: rec.storage.key, sizeBytes: 64, durationMs: 10 });
    const h = await webhook({
      id: `load-evt-${i}`,
      event: "egress_ended",
      createdAt: Math.floor(Date.now() / 1000),
      egressInfo: { egressId: rec.providerEgressId, roomName: `meeting_${id}`, status: "EGRESS_COMPLETE" },
    });
    lat.hook.push(h.ms);
    if (h.status !== 200) {
      errors += 1;
    }
    const e = await api("POST", `/api/meetings/${id}/end`, hostToken);
    lat.end.push(e.ms);
    if (e.status !== 200) {
      errors += 1;
    }
  }
  const wallMs = Date.now() - t0;
  for (const k of Object.keys(lat)) {
    lat[k].sort((a, b) => a - b);
  }
  const stuck = await Recording.countDocuments({ state: { $in: ["requested", "starting", "active", "stopping", "verifying", "unknown"] } });
  const ready = await Recording.countDocuments({ state: "ready" });
  const mem1 = process.memoryUsage();
  console.log(
    JSON.stringify(
      {
        meetings: MEETINGS,
        wallMs,
        errors,
        ready,
        recoveryBacklog: stuck,
        startMs: { p50: percentile(lat.start, 50), p95: percentile(lat.start, 95), p99: percentile(lat.start, 99) },
        webhookMs: { p50: percentile(lat.hook, 50), p95: percentile(lat.hook, 95), p99: percentile(lat.hook, 99) },
        endMs: { p50: percentile(lat.end, 50), p95: percentile(lat.end, 95), p99: percentile(lat.end, 99) },
        rssDeltaMb: Math.round((mem1.rss - mem0.rss) / 1024 / 1024),
      },
      null,
      2
    )
  );

  await sockets.close();
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await mongoose.disconnect();
  if (errors > 0 || stuck > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`load probe failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
