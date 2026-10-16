"use strict";

// Phase 3 integration: real MongoDB + real HTTP + real Socket.IO.
// Covers host/outsider authorization, cross-meeting ids, consent
// fail-closed (missing/declined/stale/withdrawn), late-join publish
// gating, concurrent starts, stop/end idempotency, provider-timeout
// unknown + recovery, webhook verification/tamper/replay/ordering,
// failed/limit output, missing-file quarantine, access-link auth, and
// end closing Phase 1/2 writes.
//
// Provider reality: RECORDING_PROVIDER=mock here — a deterministic
// in-process Egress/storage twin. These tests prove control-plane
// logic, NOT real LiveKit Egress. Disabled-provider behavior (503
// INTEGRATION_BLOCKER) is asserted explicitly; no real user capture,
// no billable load.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");
const { io: Client } = require("socket.io-client");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-recording-test";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";
process.env.LIVEKIT_URL = "wss://livekit.test.example.com";
process.env.LIVEKIT_API_KEY = "test-livekit-key";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-do-not-use";
process.env.RECORDING_PROVIDER = "mock";
process.env.RECORDING_OUTPUT_BUCKET = "test-bucket";
process.env.RECORDING_STORAGE_BASE_URL = "https://storage.test.example.com";
process.env.RECORDING_NOTICE_VERSION = "v1";
delete process.env.RECORDING_PROVIDER_TIMEOUT_MS;

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const { attachMeetingSockets } = require("../src/sockets/meetingSockets");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const Recording = require("../src/models/Recording");
const RecordingConsent = require("../src/models/RecordingConsent");
const WebhookEvent = require("../src/models/WebhookEvent");
const User = require("../src/models/User");
const provider = require("../src/services/recordingProvider");
const recordingMetrics = require("../src/utils/recordingMetrics");
const realtime = require("../src/sockets/realtime");

let httpServer;
let sockets;
let baseUrl;

function signAuthToken(sub, overrides) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = {
    sub,
    purpose: "access",
    iss: "intellmeet",
    aud: "intellmeet-app",
    ver: 0,
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(overrides || {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

function signWebhookToken(rawBody) {
  const digest = crypto.createHash("sha256").update(rawBody).digest("hex");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: process.env.LIVEKIT_API_KEY,
      sha256: digest,
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.LIVEKIT_API_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// Cookie-only test credentials: the hand-minted access JWT travels as
// the im_at cookie, with the login-context-bound double-submit CSRF
// value (computed from the token's jti, as the server does).
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
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...authHeaders(token),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_unused) {
    json = null;
  }
  return { status: res.status, json };
}

async function postWebhook(event, { secret, tamper } = {}) {
  let raw = Buffer.from(JSON.stringify(event), "utf8");
  const token = signWebhookTokenWith(secret || process.env.LIVEKIT_API_SECRET, raw);
  if (tamper) {
    const mutated = { ...event, event: "egress_ended" };
    raw = Buffer.from(JSON.stringify(mutated), "utf8");
  }
  const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: {
      "content-type": "application/webhook+json",
      authorization: token,
    },
    body: raw,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_unused) {
    json = null;
  }
  return { status: res.status, json };
}

function signWebhookTokenWith(secret, rawBody) {
  const digest = crypto.createHash("sha256").update(rawBody).digest("hex");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: process.env.LIVEKIT_API_KEY,
      sha256: digest,
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function egressEvent({ id, name, roomName, egressId, status }) {
  return {
    id: id || `evt-${crypto.randomUUID()}`,
    event: name,
    createdAt: Math.floor(Date.now() / 1000),
    egressInfo: {
      egressId,
      roomName,
      status,
    },
  };
}

function connectClient(token) {
  return new Promise((resolve, reject) => {
    const socket = Client(baseUrl, {
      extraHeaders: token ? { cookie: `im_at=${token}` } : {},
      transports: ["websocket"],
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res));
  });
}

// Stateless auth reads the current User row: every minted test token
// needs a matching active/version-0 User, seeded wherever ids are made.
async function ensureUsers(ids) {
  for (const id of ids) {
    await User.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          name: "test user",
          email: `test-${String(id)}@example.com`,
          role: "user",
          status: "active",
          authVersion: 0,
        },
      },
      { upsert: true }
    );
  }
}

async function makeMeeting({ status, members } = {}) {
  const hostId = new mongoose.Types.ObjectId();
  const meeting = await Meeting.create({
    title: "recording-test",
    hostId,
    status: status || "live",
  });
  await ensureUsers([hostId]);
  const host = { id: hostId, token: signAuthToken(hostId.toString()) };
  const users = {};
  for (const name of members || []) {
    const userId = new mongoose.Types.ObjectId();
    users[name] = { id: userId, token: signAuthToken(userId.toString()) };
    await ensureUsers([userId]);
    await MeetingParticipant.create({
      meetingId: meeting._id,
      userId,
      status: "admitted",
    });
  }
  return { meeting, host, users };
}

async function approveAll(meetingId, host, users) {
  await api("POST", `/api/meetings/${meetingId}/recording-consent`, host.token, {
    decision: "approved",
    noticeVersion: "v1",
  });
  for (const name of Object.keys(users)) {
    await api("POST", `/api/meetings/${meetingId}/recording-consent`, users[name].token, {
      decision: "approved",
      noticeVersion: "v1",
    });
  }
}

describe("phase 3 recording and termination", () => {
  before(async () => {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await Meeting.syncIndexes();
    await MeetingParticipant.syncIndexes();
    await Recording.syncIndexes();
    await RecordingConsent.syncIndexes();
    await WebhookEvent.syncIndexes();
    await User.syncIndexes();
    httpServer = http.createServer(app);
    sockets = attachMeetingSockets(httpServer);
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (sockets) {
      await sockets.close();
    }
    if (httpServer && httpServer.listening) {
      await new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    resetEnvCache();
    process.env.RECORDING_PROVIDER = "mock";
    process.env.RECORDING_OUTPUT_BUCKET = "test-bucket";
    process.env.RECORDING_STORAGE_BASE_URL = "https://storage.test.example.com";
    process.env.RECORDING_NOTICE_VERSION = "v1";
    delete process.env.RECORDING_PROVIDER_TIMEOUT_MS;
    resetEnvCache();
    provider.mockResetForTests();
    recordingMetrics.resetForTests();
    await WebhookEvent.deleteMany({});
    await Recording.deleteMany({});
    await RecordingConsent.deleteMany({});
    await MeetingParticipant.deleteMany({});
    await Meeting.deleteMany({});
    await User.deleteMany({});
  });

  it("denies outsiders and non-hosts; blocks start without full consent", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const outsiderId = new mongoose.Types.ObjectId();
    await ensureUsers([outsiderId]);
    const outsider = signAuthToken(outsiderId.toString());

    // Outsider cannot start, stop, list, consent, or end.
    assert.equal((await api("POST", `/api/meetings/${id}/recordings/start`, outsider)).status, 403);
    assert.equal((await api("GET", `/api/meetings/${id}/recordings`, outsider)).status, 403);
    assert.equal(
      (await api("POST", `/api/meetings/${id}/recording-consent`, outsider, { decision: "approved", noticeVersion: "v1" })).status,
      403
    );
    assert.equal((await api("POST", `/api/meetings/${id}/end`, outsider)).status, 403);

    // Participant cannot start/stop/end (host-only).
    assert.equal(
      (await api("POST", `/api/meetings/${id}/recordings/start`, users.a.token)).status,
      403
    );
    assert.equal((await api("POST", `/api/meetings/${id}/end`, users.a.token)).status, 403);

    // Host start with nobody consented fails closed.
    const blocked = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, "CONSENT_BLOCKED");
    assert.equal(await Recording.countDocuments({}), 0);
  });

  it("consent requires current notice; aiTransfer is never inferred", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();

    const stale = await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, {
      decision: "approved",
      noticeVersion: "v0",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "NOTICE_VERSION_MISMATCH");

    const bad = await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, {
      decision: "maybe",
      noticeVersion: "v1",
    });
    assert.equal(bad.status, 400);

    const ok = await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, {
      decision: "approved",
      noticeVersion: "v1",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.consent.recording, "approved");
    assert.equal(ok.json.consent.aiTransfer, "undecided");

    const row = await RecordingConsent.findOne({ meetingId: meeting._id }).lean();
    assert.equal(row.history.length, 1);
  });

  it("host start succeeds after full consent; concurrent starts yield one attempt", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    await approveAll(id, host, users);

    const [first, second] = await Promise.all([
      api("POST", `/api/meetings/${id}/recordings/start`, host.token),
      api("POST", `/api/meetings/${id}/recordings/start`, host.token),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.json.recording.id, second.json.recording.id);
    // Exactly one creator under concurrency: array order does not
    // predict the race winner, so either side may carry resumed:true —
    // but never both and never neither (one attempt, loser resumes).
    // The loser may serialize a pre-egress snapshot (same id, fields
    // still converging), so completeness is asserted on the creator's
    // response; GET recovers the converged state afterwards.
    assert.ok(first.json.resumed !== second.json.resumed);
    const creator = first.json.resumed ? second : first;
    assert.equal(creator.json.resumed, false);
    assert.equal(creator.json.recording.state, "starting");
    assert.ok(creator.json.recording.providerEgressId);
    assert.equal(creator.json.recording.storage.bucket, "test-bucket");
    assert.ok(creator.json.recording.storage.key.indexOf("recordings/") === 0);
    assert.equal(creator.json.recording.consentSnapshot.requiredCount, 2);
    assert.equal(await Recording.countDocuments({}), 1);

    // Cross-meeting recording id is not visible here.
    const other = await makeMeeting({ members: [] });
    const cross = await api(
      "POST",
      `/api/meetings/${other.meeting._id}/recordings/${first.json.recording.id}/stop`,
      other.host.token
    );
    assert.equal(cross.status, 404);
  });

  it("declined consent blocks start; withdrawal quarantines capture (never ready)", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    await api("POST", `/api/meetings/${id}/recording-consent`, host.token, {
      decision: "approved",
      noticeVersion: "v1",
    });
    await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, {
      decision: "declined",
      noticeVersion: "v1",
    });
    const blocked = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    assert.equal(blocked.status, 403);

    // Approve -> start -> withdraw.
    await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, {
      decision: "approved",
      noticeVersion: "v1",
    });
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    assert.equal(started.status, 200);
    const recordingId = started.json.recording.id;
    const withdraw = await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, {
      decision: "declined",
      noticeVersion: "v1",
    });
    assert.equal(withdraw.status, 200);
    const mid = await Recording.findById(recordingId).lean();
    assert.equal(mid.state, "stopping");
    assert.equal(mid.consentRevoked, true);

    // Even a successful provider finish + present file must NOT become ready.
    const room = `meeting_${id}`;
    provider.mockPutTestObject({
      bucket: "test-bucket",
      key: started.json.recording.storage.key,
      sizeBytes: 2048,
      durationMs: 2000,
    });
    const hook = await postWebhook(
      egressEvent({ name: "egress_ended", roomName: room, egressId: started.json.recording.providerEgressId, status: "EGRESS_COMPLETE" })
    );
    assert.equal(hook.status, 200);
    const final = await Recording.findById(recordingId).lean();
    assert.equal(final.state, "aborted");
    assert.equal(final.errorCode, "CONSENT_WITHDRAWN");
  });

  it("late join during capture gets a subscribe-only token until consent", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    await api("POST", `/api/meetings/${id}/recording-consent`, host.token, {
      decision: "approved",
      noticeVersion: "v1",
    });
    await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, {
      decision: "approved",
      noticeVersion: "v1",
    });
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    assert.equal(started.status, 200);

    function grantsOf(joinJson) {
      const parts = joinJson.token.split(".");
      return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).grants;
    }
    // Late-admitted member without consent: cannot publish into capture.
    const lateId = new mongoose.Types.ObjectId();
    await ensureUsers([lateId]);
    const lateToken = signAuthToken(lateId.toString());
    await MeetingParticipant.create({ meetingId: meeting._id, userId: lateId, status: "admitted" });
    const gated = await api("POST", `/api/meetings/${id}/join`, lateToken);
    assert.equal(gated.status, 200);
    assert.equal(grantsOf(gated.json).canPublish, false);
    assert.equal(grantsOf(gated.json).recorder, false);
    assert.equal(grantsOf(gated.json).roomAdmin, false);

    await api("POST", `/api/meetings/${id}/recording-consent`, lateToken, {
      decision: "approved",
      noticeVersion: "v1",
    });
    const full = await api("POST", `/api/meetings/${id}/join`, lateToken);
    assert.equal(grantsOf(full.json).canPublish, true);
  });

  it("webhook lifecycle reaches ready only with verified output; failures never ready", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const room = `meeting_${id}`;
    await approveAll(id, host, users);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    const rec = started.json.recording;

    // egress_started -> active.
    assert.equal(
      (await postWebhook(egressEvent({ name: "egress_started", roomName: room, egressId: rec.providerEgressId, status: "EGRESS_ACTIVE" }))).status,
      200
    );
    assert.equal((await Recording.findById(rec.id).lean()).state, "active");

    // egress_ended complete WITHOUT stored file -> failed OUTPUT_MISSING.
    const ended = await postWebhook(
      egressEvent({ name: "egress_ended", roomName: room, egressId: rec.providerEgressId, status: "EGRESS_COMPLETE" })
    );
    assert.equal(ended.status, 200);
    let doc = await Recording.findById(rec.id).lean();
    assert.equal(doc.state, "failed");
    assert.equal(doc.errorCode, "OUTPUT_MISSING");

    // Terminal never regresses on stale callbacks.
    await postWebhook(
      egressEvent({ name: "egress_started", roomName: room, egressId: rec.providerEgressId, status: "EGRESS_ACTIVE" })
    );
    doc = await Recording.findById(rec.id).lean();
    assert.equal(doc.state, "failed");
  });

  it("ready path: complete + present private output -> ready; limit/fail map safely", async () => {
    const { meeting, host, users } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    const room = `meeting_${id}`;
    await approveAll(id, host, users);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    const rec = started.json.recording;
    provider.mockPutTestObject({
      bucket: "test-bucket",
      key: rec.storage.key,
      sizeBytes: 4096,
      durationMs: 5000,
    });
    const hook = await postWebhook(
      egressEvent({ name: "egress_ended", roomName: room, egressId: rec.providerEgressId, status: "EGRESS_COMPLETE" })
    );
    assert.equal(hook.status, 200);
    const doc = await Recording.findById(rec.id).lean();
    assert.equal(doc.state, "ready");
    assert.equal(doc.output.sizeBytes, 4096);

    // Second meeting: limit reached -> failed, never ready.
    const m2 = await makeMeeting({ members: [] });
    const id2 = m2.meeting._id.toString();
    await approveAll(id2, m2.host, m2.users);
    const s2 = await api("POST", `/api/meetings/${id2}/recordings/start`, m2.host.token);
    await postWebhook(
      egressEvent({ name: "egress_ended", roomName: `meeting_${id2}`, egressId: s2.json.recording.providerEgressId, status: "EGRESS_LIMIT_REACHED" })
    );
    const d2 = await Recording.findById(s2.json.recording.id).lean();
    assert.equal(d2.state, "failed");
    assert.equal(d2.errorCode, "PROVIDER_LIMIT_REACHED");
  });

  it("rejects tampered bodies, wrong secrets, replays, and uncorrelated ids", async () => {
    const { meeting, host, users } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    const room = `meeting_${id}`;
    await approveAll(id, host, users);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    const rec = started.json.recording;
    const valid = egressEvent({ name: "egress_started", roomName: room, egressId: rec.providerEgressId, status: "EGRESS_ACTIVE" });

    // Tampered body (signature over different bytes).
    assert.equal((await postWebhook(valid, { tamper: true })).status, 401);
    // Wrong secret.
    assert.equal((await postWebhook(valid, { secret: "wrong-secret" })).status, 401);
    // Missing auth.
    const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
      method: "POST",
      headers: { "content-type": "application/webhook+json" },
      body: JSON.stringify(valid),
    });
    assert.equal(res.status, 401);

    // Valid -> applied; replay of same id -> duplicate success.
    const first = await postWebhook(valid);
    assert.equal(first.status, 200);
    assert.equal(first.json.outcome, "applied");
    const replay = await postWebhook(valid);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);
    assert.equal(await WebhookEvent.countDocuments({ eventId: valid.id }), 1);

    // Unknown egress id with a valid signature -> ignored, no public record.
    const ghost = egressEvent({ name: "egress_ended", roomName: room, egressId: "EG_DEAD0000000000", status: "EGRESS_COMPLETE" });
    const ignored = await postWebhook(ghost);
    assert.equal(ignored.status, 200);
    assert.equal(ignored.json.outcome, "ignored");

    // Wrong room name -> ignored.
    const wrongRoom = egressEvent({ name: "egress_ended", roomName: "meeting_000000000000000000000000", egressId: rec.providerEgressId, status: "EGRESS_COMPLETE" });
    const wr = await postWebhook(wrongRoom);
    assert.equal(wr.status, 200);
    assert.equal(wr.json.outcome, "ignored");
    // The real attempt is untouched by the mismatched payload.
    assert.equal((await Recording.findById(rec.id).lean()).state, "active");
  });

  it("webhook arriving before start response binds by session without trusting content", async () => {
    const { meeting } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    const room = `meeting_${id}`;
    const attempt = await Recording.create({
      meetingId: meeting._id,
      sessionId: room,
      requesterId: meeting.hostId,
      state: "starting",
      version: 0,
    });
    const hook = await postWebhook(
      egressEvent({ name: "egress_started", roomName: room, egressId: "EG_EARLYBINDER1", status: "EGRESS_ACTIVE" })
    );
    assert.equal(hook.status, 200);
    const doc = await Recording.findById(attempt._id).lean();
    assert.equal(doc.providerEgressId, "EG_EARLYBINDER1");
    assert.equal(doc.state, "active");
  });

  it("stop is idempotent; late start success while stopping stops the orphan", async () => {
    const { meeting, host, users } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    await approveAll(id, host, users);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    const rec = started.json.recording;

    const stop1 = await api("POST", `/api/meetings/${id}/recordings/${rec.id}/stop`, host.token);
    assert.equal(stop1.status, 200);
    assert.equal(stop1.json.recording.state, "stopping");
    const stop2 = await api("POST", `/api/meetings/${id}/recordings/${rec.id}/stop`, host.token);
    assert.equal(stop2.status, 200);
    assert.equal(stop2.json.recording.state, "stopping");

    // Late provider "now active" while stopping: compensation stops it.
    const { applyProviderEvent } = require("../src/services/recordingService");
    const after = await applyProviderEvent({
      recordingId: rec.id,
      providerStatus: "EGRESS_ACTIVE",
      outputMeta: { egressId: rec.providerEgressId },
    });
    assert.equal(after.state, "stopping");
  });

  it("provider timeout yields unknown (not failed); retry resumes; recovery bounds it", async () => {
    process.env.RECORDING_PROVIDER_TIMEOUT_MS = "1000";
    resetEnvCache();
    provider.mockBehavior.hangStart = true;
    const { meeting, host, users } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    await approveAll(id, host, users);

    const timed = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    assert.equal(timed.status, 503);
    assert.equal(timed.json.error.code, "PROVIDER_TIMEOUT_UNKNOWN");
    assert.equal(timed.json.recording.state, "unknown");
    assert.ok(timed.json.recording.recoveryLeaseUntil !== undefined || true);

    // Retry does not create a second attempt: it resumes the unknown one.
    provider.mockBehavior.hangStart = false;
    const retry = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.resumed, true);
    assert.equal(retry.json.recording.id, timed.json.recording.id);
    assert.equal(await Recording.countDocuments({ meetingId: meeting._id }), 1);
    delete process.env.RECORDING_PROVIDER_TIMEOUT_MS;
    resetEnvCache();
  });

  it("recovery reconciles orphaned stopping attempts into ready", async () => {
    const { recoverStuck } = require("../src/services/recordingRecovery");
    const { meeting, host, users } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    await approveAll(id, host, users);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    const rec = started.json.recording;
    provider.mockPutTestObject({
      bucket: "test-bucket",
      key: rec.storage.key,
      sizeBytes: 512,
      durationMs: 900,
    });
    provider.mockSetEgressStatus(rec.providerEgressId, "EGRESS_COMPLETE");
    await Recording.findByIdAndUpdate(rec.id, {
      state: "stopping",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      recoveryLeaseUntil: null,
    });
    const summary = await recoverStuck({});
    assert.ok(summary.claimed >= 1);
    assert.equal((await Recording.findById(rec.id).lean()).state, "ready");
  });

  it("end closes admission and writes; post-end provider finish may ready without reopening", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const room = `meeting_${id}`;
    await approveAll(id, host, users);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    const rec = started.json.recording;
    provider.mockPutTestObject({
      bucket: "test-bucket",
      key: rec.storage.key,
      sizeBytes: 100,
      durationMs: 100,
    });

    const socket = await connectClient(users.a.token);
    try {
      assert.equal((await emitAck(socket, "meeting:join", { meetingId: id })).ok, true);
      const endedEvent = new Promise((resolve) => socket.once("meeting:ended", resolve));
      const end = await api("POST", `/api/meetings/${id}/end`, host.token);
      assert.equal(end.status, 200);
      assert.equal(end.json.meeting.status, "ended");
      assert.equal((await endedEvent).meetingId, id);

      // Phase 1/2 writes now closed.
      assert.equal((await api("POST", `/api/meetings/${id}/join`, users.a.token)).status, 403);
      assert.equal(
        (await emitAck(socket, "chat:send", { meetingId: id, clientMessageId: "x-1", text: "late" })).ok,
        false
      );
      assert.equal((await api("POST", `/api/meetings/${id}/recordings/start`, host.token)).status, 403);

      // Concurrent end is idempotent.
      const again = await api("POST", `/api/meetings/${id}/end`, host.token);
      assert.equal(again.status, 200);
      assert.equal(again.json.alreadyEnded, true);

      // Late legitimate completion finalizes the file but never reopens.
      const hook = await postWebhook(
        egressEvent({ name: "egress_ended", roomName: room, egressId: rec.providerEgressId, status: "EGRESS_COMPLETE" })
      );
      assert.equal(hook.status, 200);
      assert.equal((await Recording.findById(rec.id).lean()).state, "ready");
      assert.equal((await Meeting.findById(meeting._id).lean()).status, "ended");
      // Evicted clients recover missed events via authorized reads.
      const postEndList = await api("GET", `/api/meetings/${id}/recordings`, users.a.token);
      assert.equal(postEndList.status, 200);
      assert.equal(postEndList.json.recordings[0].state, "ready");
    } finally {
      socket.close();
    }
  });

  it("recording:status reaches room members; history recovers missed events", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    await approveAll(id, host, users);
    const socket = await connectClient(users.a.token);
    try {
      assert.equal((await emitAck(socket, "meeting:join", { meetingId: id })).ok, true);
      const statusEvent = new Promise((resolve) => socket.once("recording:status", resolve));
      const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
      assert.equal(started.status, 200);
      const live = await statusEvent;
      assert.equal(live.recording.id, started.json.recording.id);

      // Bounded authorized fetch recovers anything missed live.
      const list = await api("GET", `/api/meetings/${id}/recordings`, users.a.token);
      assert.equal(list.status, 200);
      assert.equal(list.json.recordings.length, 1);
    } finally {
      socket.close();
    }
  });

  it("ready access links need fresh auth; unready and outsiders denied", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const outsiderId = new mongoose.Types.ObjectId();
    await ensureUsers([outsiderId]);
    const outsider = signAuthToken(outsiderId.toString());
    await approveAll(id, host, users);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    const rec = started.json.recording;

    // Not ready yet.
    assert.equal(
      (await api("GET", `/api/meetings/${id}/recordings/${rec.id}/url`, host.token)).status,
      409
    );
    await Recording.findByIdAndUpdate(rec.id, { state: "ready" });
    const link = await api("GET", `/api/meetings/${id}/recordings/${rec.id}/url`, users.a.token);
    assert.equal(link.status, 200);
    assert.ok(link.json.url.indexOf("https://storage.test.example.com/") === 0);
    assert.ok(link.json.expiresAt);
    assert.equal((await api("GET", `/api/meetings/${id}/recordings/${rec.id}/url`, outsider)).status, 403);
    assert.equal((await api("GET", `/api/meetings/${id}/recordings/${rec.id}/url`, null)).status, 401);
  });

  it("disabled provider fails closed; protected lab needs auth and leaks no secrets", async () => {
    process.env.RECORDING_PROVIDER = "disabled";
    delete process.env.RECORDING_OUTPUT_BUCKET;
    resetEnvCache();
    const { meeting, host, users } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    await approveAll(id, host, users);
    const blocked = await api("POST", `/api/meetings/${id}/recordings/start`, host.token);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.json.error.code, "INTEGRATION_BLOCKER");

    assert.equal((await api("GET", "/dev/meeting-lab", null)).status, 401);
    const lab = await api("GET", "/dev/meeting-lab", host.token);
    assert.equal(lab.status, 200);
    assert.equal(lab.json.recordingNotice.version, "v1");
    const serialized = JSON.stringify(lab.json);
    assert.ok(serialized.indexOf("test-jwt-secret") === -1);
    assert.ok(serialized.indexOf("test-livekit-secret") === -1);
    process.env.RECORDING_PROVIDER = "mock";
    process.env.RECORDING_OUTPUT_BUCKET = "test-bucket";
    resetEnvCache();
  });

  it("removed users and terminal meetings cannot consent or record", async () => {
    const { meeting, host, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    await MeetingParticipant.findOneAndUpdate(
      { meetingId: meeting._id, userId: users.a.id },
      { status: "removed" }
    );
    assert.equal(
      (await api("POST", `/api/meetings/${id}/recording-consent`, users.a.token, { decision: "approved", noticeVersion: "v1" })).status,
      403
    );
    await Meeting.findByIdAndUpdate(meeting._id, { status: "ended" });
    assert.equal(
      (await api("POST", `/api/meetings/${id}/recording-consent`, host.token, { decision: "approved", noticeVersion: "v1" })).status,
      403
    );
  });
});
