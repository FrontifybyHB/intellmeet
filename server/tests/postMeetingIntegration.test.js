"use strict";

// Phase 6 post-meeting integration: two users (host + admitted member)
// plus an outsider drive the full chain over real HTTP + real
// Socket.IO + real MongoDB + real Redis/BullMQ + REAL workers:
//
// consent -> chat -> record -> stop -> verified ready -> end ->
// auto-enqueued transcription -> published segments -> intelligence ->
// reviewed suggestion -> history/detail reads.
//
// Providers are mock twins (labeled): synthetic WAV bytes through the
// mock Egress output path and deterministic Gemini fixtures. These
// prove integration/orchestration, NEVER live-provider E2E (no
// LiveKit server, Egress credentials, or Gemini budget here — recorded
// as BLOCKED). Meeting create/admit rows are seeded via models:
// meeting CRUD is team-owned and has no endpoints in this repo.
//
// A second meeting covers declined consent and the legitimate
// no-recording/no-action outcomes: endpoints return explicit states,
// never misleading empty success.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");
const Client = require("socket.io-client");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-integration-test";
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
// Mock-Egress output configured as WAV: no audio extractor exists for
// containers in this repo, so an mp4 mock output would honestly block
// transcription with EXTRACTION_UNAVAILABLE (covered in Phase 4
// tests). WAV keeps the mock boundary honest end to end.
process.env.RECORDING_OUTPUT_FORMAT = "wav";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.INTELLIGENCE_PROVIDER = "mock";
// Dedicated Redis DB 14: node --test runs suites in parallel and each
// queue suite flushes its DB between tests — sharing one DB orphans
// other suites' waiting BullMQ jobs mid-flight. Same per-suite
// isolation Mongo already uses.
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379/14";
delete process.env.GEMINI_API_KEY;

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
const WebhookEvent = require("../src/models/WebhookEvent");
const recordingProvider = require("../src/services/recordingProvider");
const geminiTx = require("../src/services/geminiTranscriptionProvider");
const geminiIx = require("../src/services/geminiIntelligenceProvider");
const transcriptionAudio = require("../src/services/transcriptionAudio");
const transcriptionQueue = require("../src/queues/transcriptionQueue");
const intelligenceQueue = require("../src/queues/intelligenceQueue");

let httpServer;
let sockets;
let baseUrl;

function signAuthToken(sub) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = {
    sub,
    purpose: "access",
    iss: "intellmeet",
    aud: "intellmeet-app",
    ver: 0,
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

// Stateless auth reads the current User row: every minted test token
// needs a matching active/version-0 User.
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

async function api(method, path, token, body, query) {
  const url = query ? `${baseUrl}${path}?${query}` : `${baseUrl}${path}`;
  const res = await fetch(url, {
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

function parseCookies(res) {
  const out = {};
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) {
      out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return out;
}

function jarHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function cookieApi(method, path, jar, body, csrfToken) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(jar ? { cookie: jarHeader(jar) } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
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

function signWebhookToken(rawBody) {
  const digest = crypto.createHash("sha256").update(rawBody).digest("hex");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
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

async function postWebhook(event) {
  const raw = Buffer.from(JSON.stringify(event), "utf8");
  const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: {
      "content-type": "application/webhook+json",
      authorization: signWebhookToken(raw),
    },
    body: raw,
  });
  return { status: res.status };
}

function connectSocket(token) {
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

// Bounded condition wait (polls every 100ms, fails loudly on timeout
// — never an unbounded sleep hiding a stuck pipeline).
async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("phase 6 post-meeting integration", () => {
  before(async () => {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await Promise.all([
      Meeting.syncIndexes(),
      MeetingParticipant.syncIndexes(),
      Recording.syncIndexes(),
      RecordingConsent.syncIndexes(),
      TranscriptSegment.syncIndexes(),
      MeetingIntelligence.syncIndexes(),
      ActionItem.syncIndexes(),
      WebhookEvent.syncIndexes(),
      User.syncIndexes(),
    ]);
    transcriptionQueue.getConnection();
    intelligenceQueue.getConnection();
    const redis = transcriptionQueue.getConnection();
    await redis.flushdb();
    httpServer = http.createServer(app);
    sockets = attachMeetingSockets(httpServer);
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    const { startTranscriptionWorker } = require("../src/queues/transcriptionWorker");
    const { startIntelligenceWorker } = require("../src/queues/intelligenceWorker");
    await startTranscriptionWorker();
    await startIntelligenceWorker();
  });

  after(async () => {
    try {
      const { stopTranscriptionWorker } = require("../src/queues/transcriptionWorker");
      await stopTranscriptionWorker();
    } catch (_unused) {
      // Ignore.
    }
    try {
      const { stopIntelligenceWorker } = require("../src/queues/intelligenceWorker");
      await stopIntelligenceWorker();
    } catch (_unused) {
      // Ignore.
    }
    await transcriptionQueue.closeForTests();
    await intelligenceQueue.closeForTests();
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
    process.env.RECORDING_OUTPUT_FORMAT = "wav";
    process.env.TRANSCRIPTION_PROVIDER = "mock";
    process.env.INTELLIGENCE_PROVIDER = "mock";
    resetEnvCache();
    recordingProvider.mockResetForTests();
    geminiTx.mockResetTranscriptionForTests();
    geminiIx.mockResetIntelligenceForTests();
    const redis = transcriptionQueue.getConnection();
    await redis.flushdb();
    await Promise.all([
      ActionItem.deleteMany({}),
      MeetingIntelligence.deleteMany({}),
      TranscriptSegment.deleteMany({}),
      Recording.deleteMany({}),
      RecordingConsent.deleteMany({}),
      MeetingParticipant.deleteMany({}),
      Meeting.deleteMany({}),
      WebhookEvent.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  it("two-user full chain: join, chat, consent, record, end, transcript, intelligence, review, reads", async () => {
    // Seed (team-owned CRUD has no endpoints): live meeting + member.
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    const outsiderId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, memberId, outsiderId]);
    const meeting = await Meeting.create({ title: "e2e-full", hostId, status: "live" });
    await MeetingParticipant.create({ meetingId: meeting._id, userId: memberId, status: "admitted" });
    const id = meeting._id.toString();
    const hostToken = signAuthToken(hostId.toString());
    const memberToken = signAuthToken(memberId.toString());
    const outsiderToken = signAuthToken(outsiderId.toString());

    // Join tokens: host + member succeed, outsider denied.
    const joinHost = await api("POST", `/api/meetings/${id}/join`, hostToken);
    assert.equal(joinHost.status, 200);
    assert.ok(joinHost.json.token);
    assert.equal(joinHost.json.permissions.isHost, true);
    const joinMember = await api("POST", `/api/meetings/${id}/join`, memberToken);
    assert.equal(joinMember.status, 200);
    assert.equal(joinMember.json.permissions.isHost, false);
    assert.equal((await api("POST", `/api/meetings/${id}/join`, outsiderToken)).status, 403);

    // Socket chat: both join, member sends, host receives live; history
    // persists; outsider socket cannot enter the room.
    const hostSocket = await connectSocket(hostToken);
    const memberSocket = await connectSocket(memberToken);
    try {
      assert.equal((await emitAck(hostSocket, "meeting:join", { meetingId: id })).ok, true);
      assert.equal((await emitAck(memberSocket, "meeting:join", { meetingId: id })).ok, true);
      const received = new Promise((resolve) => hostSocket.once("chat:message", resolve));
      const sent = await emitAck(memberSocket, "chat:send", {
        meetingId: id,
        clientMessageId: `e2e-${Date.now()}`,
        text: "hello from member",
      });
      assert.equal(sent.ok, true);
      const live = await received;
      assert.equal(live.text, "hello from member");
      // Duplicate send dedupes by idempotency key.
      const dup = await emitAck(memberSocket, "chat:send", {
        meetingId: id,
        clientMessageId: sent.message.clientMessageId,
        text: "hello from member",
      });
      assert.equal(dup.ok, true);
      assert.equal(dup.message.id, sent.message.id);

      const outsiderSocket = await connectSocket(outsiderToken);
      try {
        const denied = await emitAck(outsiderSocket, "meeting:join", { meetingId: id });
        assert.equal(denied.ok, false);
      } finally {
        outsiderSocket.close();
      }
    } finally {
      hostSocket.close();
      memberSocket.close();
    }
    const history = await api("GET", `/api/meetings/${id}/messages`, memberToken);
    assert.equal(history.status, 200);
    assert.equal(history.json.messages.length, 1);

    // Explicit recording + Google-purpose consent from both humans.
    for (const token of [hostToken, memberToken]) {
      const consent = await api("POST", `/api/meetings/${id}/recording-consent`, token, {
        decision: "approved",
        noticeVersion: "v1",
        aiTransfer: "approved",
      });
      assert.equal(consent.status, 200);
    }

    // Host records; member cannot.
    assert.equal((await api("POST", `/api/meetings/${id}/recordings/start`, memberToken)).status, 403);
    const started = await api("POST", `/api/meetings/${id}/recordings/start`, hostToken);
    assert.equal(started.status, 200);
    const rec = started.json.recording;
    const stopped = await api("POST", `/api/meetings/${id}/recordings/${rec.id}/stop`, hostToken);
    assert.equal(stopped.status, 200);

    // Private verified output ready: place synthetic WAV bytes, then a
    // verified provider webhook flips the attempt to ready.
    const bytes = transcriptionAudio.synthesizeWav({
      sampleRate: 16000,
      parts: [{ freqHz: 440, ms: 3000 }, { freqHz: 0, ms: 500 }, { freqHz: 660, ms: 3000 }],
    });
    recordingProvider.mockPutAudioBytesForTests({
      bucket: "test-bucket",
      key: rec.storage.key,
      bytes,
      durationMs: 6500,
    });
    geminiTx.mockRegisterReference(transcriptionAudio.sha256Hex(bytes), {
      segments: [
        { startMs: 0, endMs: 2500, text: "We decided to ship Monday.", language: "en", speakerLabel: "speaker_1" },
        { startMs: 3000, endMs: 6000, text: "Priya will draft the notes.", language: "en", speakerLabel: "speaker_2" },
      ],
    });
    const hook = await postWebhook({
      id: `evt-${crypto.randomUUID()}`,
      event: "egress_ended",
      createdAt: Math.floor(Date.now() / 1000),
      egressInfo: { egressId: rec.providerEgressId, roomName: `meeting_${id}`, status: "EGRESS_COMPLETE" },
    });
    assert.equal(hook.status, 200);
    assert.equal((await Recording.findById(rec.id).lean()).state, "ready");

    // Host ends the meeting: admission closes, eligible transcription
    // auto-enqueues from persisted intent.
    assert.equal((await api("POST", `/api/meetings/${id}/end`, hostToken)).status, 200);

    // Real transcription worker completes the run (bounded wait).
    const txDone = await waitFor("transcript complete", async () => {
      const doc = await Recording.findById(rec.id, { transcription: 1 }).lean();
      return doc && doc.transcription && doc.transcription.state === "complete" ? doc : null;
    });
    assert.equal(typeof txDone.transcription.publishedRunVersion, "number");
    assert.equal(txDone.transcription.segmentCount, 2);
    const transcript = await api(
      "GET",
      `/api/meetings/${id}/recordings/${rec.id}/transcript?limit=10`,
      memberToken
    );
    assert.equal(transcript.status, 200);
    assert.equal(transcript.json.segments.length, 2);
    assert.equal(transcript.json.segments[0].text, "We decided to ship Monday.");

    // Intelligence over the published transcript (real worker).
    geminiIx.mockRegisterIntelligenceResponse("default", {
      summaryBullets: [{ text: "Team will ship Monday.", evidence: { segmentIds: ["0:0"] } }],
      decisions: [{ text: "Ship Monday.", evidence: { segmentIds: ["0:0"] } }],
      blockers: [],
      unresolvedQuestions: [],
      suggestedActions: [
        {
          title: "Draft the notes",
          detail: "Draft release notes",
          evidence: { segmentIds: ["0:1"] },
          proposedOwnerText: "Priya",
          dueDateText: null,
        },
      ],
    });
    const enqIx = await api("POST", `/api/meetings/${id}/recordings/${rec.id}/intelligence`, hostToken);
    assert.equal(enqIx.status, 200);
    const ixDone = await waitFor("intelligence complete", async () => {
      const doc = await MeetingIntelligence.findOne({ recordingId: rec.id }).lean();
      return doc && doc.state === "complete" ? doc : null;
    });
    assert.deepEqual(ixDone.summaryBullets, [
      { text: "Team will ship Monday.", evidence: { segmentIds: ["0:0"], startMs: 0, endMs: 2500 } },
    ]);

    const intelRead = await api("GET", `/api/meetings/${id}/recordings/${rec.id}/intelligence`, memberToken);
    assert.equal(intelRead.status, 200);
    assert.equal(intelRead.json.output.decisions[0].evidence.segmentIds[0], "0:0");

    // Human review: host approves with the verified member as owner.
    const items = await api("GET", `/api/meetings/${id}/recordings/${rec.id}/action-items`, memberToken);
    assert.equal(items.json.items.length, 1);
    const itemId = items.json.items[0].id;
    const approved = await api("PATCH", `/api/meetings/${id}/action-items/${itemId}`, hostToken, {
      action: "approve",
      version: items.json.items[0].version,
      title: "Draft the notes",
      ownerUserId: memberId.toString(),
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.item.state, "approved");
    assert.equal(approved.json.item.reviewed.ownerUserId, memberId.toString());
    // Approved action → one real Task (idempotent): first create is
    // 201, duplicate POST / timeout replay resumes the same task.
    const task = await api("POST", `/api/meetings/${id}/action-items/${itemId}/task`, hostToken, {});
    assert.equal(task.status, 201);
    assert.ok(task.json.task.id);
    assert.equal(task.json.task.title, "Draft the notes");
    assert.equal(task.json.task.ownerUserId, memberId.toString());
    assert.equal(task.json.resumed, false);
    const replay = await api("POST", `/api/meetings/${id}/action-items/${itemId}/task`, hostToken, {});
    assert.equal(replay.status, 200);
    assert.equal(replay.json.resumed, true);
    assert.equal(replay.json.task.id, task.json.task.id);

    // History + detail: member sees entitled meeting and pointers only
    // (no blobs, no profiles); outsider sees nothing.
    const historyList = await api("GET", "/api/meetings", memberToken);
    assert.equal(historyList.status, 200);
    assert.ok(historyList.json.meetings.some((row) => row.id === id));
    const listed = historyList.json.meetings.find((row) => row.id === id);
    assert.equal(listed.status, "ended");
    assert.equal(listed.isHost, false);
    assert.ok(!("transcript" in listed) && !("summary" in listed));

    const detail = await api("GET", `/api/meetings/${id}`, memberToken);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.meeting.id, id);
    assert.equal(detail.json.recording.state, "ready");
    assert.equal(detail.json.transcription.state, "complete");
    assert.equal(detail.json.transcription.segmentCount, 2);
    assert.equal(detail.json.intelligence.state, "complete");
    assert.deepEqual(detail.json.suggestions, { proposed: 0, approved: 1, rejected: 0 });

    // Outsider: entitled history is legitimately empty (200 with no
    // rows is correct here — the list never leaks foreign meetings);
    // every direct read is denied.
    const outsiderList = await api("GET", "/api/meetings", outsiderToken);
    assert.equal(outsiderList.status, 200);
    assert.ok(!outsiderList.json.meetings.some((row) => row.id === id));
    for (const path of [
      `/api/meetings/${id}`,
      `/api/meetings/${id}/messages`,
      `/api/meetings/${id}/recordings`,
      `/api/meetings/${id}/recordings/${rec.id}/transcript`,
      `/api/meetings/${id}/recordings/${rec.id}/intelligence`,
      `/api/meetings/${id}/recordings/${rec.id}/action-items`,
    ]) {
      const res = await api("GET", path, outsiderToken);
      assert.ok([403, 404].includes(res.status), `${path} leaked: ${res.status}`);
    }
    assert.equal((await api("POST", `/api/meetings/${id}/recordings/${rec.id}/intelligence`, outsiderToken)).status, 403);
  });

  it("declined consent: no recording, honest empty states, nothing auto-enqueues", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, memberId]);
    const meeting = await Meeting.create({ title: "e2e-declined", hostId, status: "live" });
    await MeetingParticipant.create({ meetingId: meeting._id, userId: memberId, status: "admitted" });
    const id = meeting._id.toString();
    const hostToken = signAuthToken(hostId.toString());
    const memberToken = signAuthToken(memberId.toString());

    const declined = await api("POST", `/api/meetings/${id}/recording-consent`, memberToken, {
      decision: "declined",
      noticeVersion: "v1",
    });
    assert.equal(declined.status, 200);
    await api("POST", `/api/meetings/${id}/recording-consent`, hostToken, {
      decision: "approved",
      noticeVersion: "v1",
      aiTransfer: "approved",
    });
    // Start blocked without full consent — explicit failure, not silence.
    const start = await api("POST", `/api/meetings/${id}/recordings/start`, hostToken);
    assert.ok([400, 403, 409].includes(start.status));
    assert.equal((await Recording.countDocuments({ meetingId: meeting._id })) === 0, true);

    assert.equal((await api("POST", `/api/meetings/${id}/end`, hostToken)).status, 200);

    // History/detail show the meeting with null pipeline pointers: a
    // legitimate no-recording outcome, not a misleading empty success.
    const detail = await api("GET", `/api/meetings/${id}`, hostToken);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.meeting.status, "ended");
    assert.equal(detail.json.recording, null);
    assert.equal(detail.json.transcription, null);
    assert.equal(detail.json.intelligence, null);
    assert.deepEqual(detail.json.suggestions, { proposed: 0, approved: 0, rejected: 0 });
    const list = await api("GET", "/api/meetings", memberToken);
    assert.ok(list.json.meetings.some((row) => row.id === id));
  });

  it("history pagination is bounded, stable, and never escapes entitlement", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, otherId]);
    const hostToken = signAuthToken(hostId.toString());
    const otherToken = signAuthToken(otherId.toString());
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const meeting = await Meeting.create({ title: `page-${i}`, hostId, status: "ended" });
      ids.push(meeting._id.toString());
    }
    const foreign = await Meeting.create({ title: "foreign", hostId: otherId, status: "ended" });

    const page1 = await api("GET", "/api/meetings?limit=2", hostToken);
    assert.equal(page1.status, 200);
    assert.equal(page1.json.meetings.length, 2);
    assert.equal(page1.json.hasMore, true);
    assert.ok(page1.json.nextCursor);
    // Newest-first by _id.
    assert.ok(page1.json.meetings[0].id >= page1.json.meetings[1].id);
    const page2 = await api("GET", `/api/meetings?limit=2&cursor=${page1.json.nextCursor}`, hostToken);
    assert.equal(page2.json.meetings.length, 1);
    assert.equal(page2.json.hasMore, false);
    // No overlap across pages (stable ordering).
    const seen = new Set([...page1.json.meetings, ...page2.json.meetings].map((row) => row.id));
    assert.equal(seen.size, 3);
    // Foreign meeting never appears; direct read denied.
    assert.ok(![...page1.json.meetings, ...page2.json.meetings].some((row) => row.id === foreign._id.toString()));
    assert.equal((await api("GET", `/api/meetings/${foreign._id}`, hostToken)).status, 403);
    // Malformed cursor/limit rejected, not silently coerced.
    assert.equal((await api("GET", "/api/meetings?cursor=nope", hostToken)).status, 400);
    assert.equal((await api("GET", "/api/meetings?limit=0", hostToken)).status, 400);
    assert.equal((await api("GET", "/api/meetings/not-an-id", hostToken)).status, 400);
    assert.equal((await api("GET", "/api/meetings", null)).status, 401);
  });

  it("security: expired/forged auth, no-store reads, mass-assignment, xss round-trip, removal recheck", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, memberId]);
    const meeting = await Meeting.create({ title: "sec", hostId, status: "ended" });
    await MeetingParticipant.create({ meetingId: meeting._id, userId: memberId, status: "admitted" });
    const id = meeting._id.toString();
    const hostToken = signAuthToken(hostId.toString());
    const memberToken = signAuthToken(memberId.toString());

    function signExpired(sub) {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ sub, iat: 1000, exp: 1001 })
      ).toString("base64url");
      const sig = crypto
        .createHmac("sha256", process.env.JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url");
      return `${header}.${payload}.${sig}`;
    }
    const expired = signExpired(hostId.toString());
    assert.equal((await api("GET", "/api/meetings", expired)).status, 401);
    assert.equal((await api("GET", `/api/meetings/${id}`, expired)).status, 401);
    // Forged signature (wrong secret) rejected without detail leakage.
    const forged = signExpired(hostId.toString()).slice(0, -2) + "xx";
    const forgedRes = await api("GET", "/api/meetings", forged);
    assert.equal(forgedRes.status, 401);
    assert.equal(forgedRes.json.error.code, "UNAUTHORIZED");

    // Private cache isolation: reads are never stored by intermediaries.
    for (const path of ["/api/meetings", `/api/meetings/${id}`]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { cookie: `im_at=${memberToken}` },
      });
      assert.equal(res.headers.get("cache-control"), "no-store");
      await res.text();
    }

    // Removal recheck: a removed participant loses read access at once.
    await MeetingParticipant.findOneAndUpdate(
      { meetingId: meeting._id, userId: memberId },
      { $set: { status: "removed" } }
    );
    assert.equal((await api("GET", `/api/meetings/${id}`, memberToken)).status, 403);
    const listAfter = await api("GET", "/api/meetings", memberToken);
    assert.ok(!listAfter.json.meetings.some((row) => row.id === id));
    await MeetingParticipant.findOneAndUpdate(
      { meetingId: meeting._id, userId: memberId },
      { $set: { status: "admitted" } }
    );

    // Mass-assignment: injected state/task/role fields are ignored —
    // review acts only on whitelisted fields, with no escalation.
    const recording = await Recording.create({
      meetingId: meeting._id,
      sessionId: `meeting_${id}`,
      requesterId: hostId,
      state: "ready",
      version: 1,
      storage: { bucket: "test-bucket", key: `recordings/${id}/run.wav`, format: "wav" },
      output: { sizeBytes: 10, durationMs: 1000 },
      transcription: { state: "complete", runId: "tr_x", runVersion: 1, publishedRunVersion: 1, segmentCount: 1 },
    });
    await TranscriptSegment.create({
      meetingId: meeting._id,
      recordingId: recording._id,
      runId: "tr_x",
      runVersion: 1,
      chunkIndex: 0,
      ordinal: 0,
      offsetMs: 0,
      startMs: 0,
      endMs: 1000,
      text: "seed",
    });
    const intel = await MeetingIntelligence.create({
      meetingId: meeting._id,
      recordingId: recording._id,
      sourceTranscriptRunId: "tr_x",
      sourceTranscriptRunVersion: 1,
      sourceSegmentCount: 1,
      runId: `ix_sec_${Date.now()}`,
      runVersion: 1,
      version: 1,
      state: "complete",
      pipelineVersion: "i1",
      model: "m",
      promptVersion: "p1",
      schemaVersion: "s2",
      contextVersion: "c1",
      consentNoticeVersion: "v1",
      summaryBullets: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      publishedAt: new Date(),
      enqueuedAt: new Date(),
      updatedAt: new Date(),
    });
    const item = await ActionItem.create({
      meetingId: meeting._id,
      recordingId: recording._id,
      intelligenceId: intel._id,
      intelligenceRunId: intel.runId,
      intelligenceRunVersion: 1,
      suggestionKey: "sec-key-1",
      titleProposed: "Seeded task",
      evidenceSegmentIds: ["0:0"],
      state: "proposed",
      version: 0,
      taskLink: { status: "blocked", reason: "NOT_APPROVED" },
    });
    const injected = await api("PATCH", `/api/meetings/${id}/action-items/${item._id}`, hostToken, {
      action: "approve",
      version: 0,
      confirmUnassigned: true,
      state: "taskCreated",
      taskLink: { status: "created" },
      reviewedBy: memberId.toString(),
      role: "admin",
      ownerUserId: undefined,
    });
    assert.equal(injected.status, 200);
    assert.equal(injected.json.item.state, "approved");
    // Injected task/state escalation did not take.
    const stored = await ActionItem.findById(item._id).lean();
    assert.equal(stored.taskLink.status, "blocked");
    assert.equal(String(stored.reviewedBy), hostId.toString());

    // Stored XSS round-trip: server preserves exact text (no silent
    // transform/strip); escaping at render time is the UI owner's duty.
    const xss = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    await Meeting.findByIdAndUpdate(meeting._id, { status: "live" });
    const sock = await connectSocket(hostToken);
    try {
      assert.equal((await emitAck(sock, "meeting:join", { meetingId: id })).ok, true);
      const sendRes = await emitAck(sock, "chat:send", {
        meetingId: id,
        clientMessageId: `xss-${Date.now()}`,
        text: xss,
      });
      assert.equal(sendRes.ok, true);
    } finally {
      sock.close();
    }
    const hist = await api("GET", `/api/meetings/${id}/messages`, hostToken);
    assert.ok(hist.json.messages.some((row) => row.text === xss));
  });

  it("cookie-authenticated meeting writes require CSRF; Bearer is not a credential path", async () => {
    const email = `csrf-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = "correct horse battery staple!";
    // Pre-login anonymous CSRF bootstrap (required on register/login).
    const boot = await fetch(`${baseUrl}/api/auth/csrf`);
    assert.equal(boot.status, 200);
    const bootJar = parseCookies(boot);
    const bootBody = await boot.json();
    const anonHeaders = {
      "content-type": "application/json",
      cookie: jarHeader(bootJar),
      "x-csrf-token": bootBody.csrfToken,
    };
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: anonHeaders,
      body: JSON.stringify({ name: "CSRF Host", email, password }),
    });
    assert.equal(reg.status, 201);
    await reg.text();
    const log = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: anonHeaders,
      body: JSON.stringify({ email, password }),
    });
    assert.equal(log.status, 200);
    const loginBody = await log.json();
    const jar = parseCookies(log);
    assert.ok(jar.im_at, "expected access cookie");
    const csrfToken = loginBody.csrfToken;
    assert.ok(csrfToken, "expected csrf token");
    const hostId = loginBody.user.id;
    const meeting = await Meeting.create({ title: "csrf", hostId, status: "live" });
    const id = meeting._id.toString();
    // Cookie-only without CSRF → 403 CSRF_REQUIRED (consent + end).
    const noCsrfConsent = await cookieApi("POST", `/api/meetings/${id}/recording-consent`, jar, {
      decision: "approved",
      noticeVersion: "v1",
      aiTransfer: "approved",
    });
    assert.equal(noCsrfConsent.status, 403);
    assert.equal(noCsrfConsent.json.error.code, "CSRF_REQUIRED");
    const noCsrfEnd = await cookieApi("POST", `/api/meetings/${id}/end`, jar, {});
    assert.equal(noCsrfEnd.status, 403);
    assert.equal(noCsrfEnd.json.error.code, "CSRF_REQUIRED");
    // Valid CSRF succeeds (consent 200, end 200); wrong token is invalid.
    const badCsrf = await cookieApi(
      "POST",
      `/api/meetings/${id}/recording-consent`,
      jar,
      { decision: "approved", noticeVersion: "v1", aiTransfer: "approved" },
      "bad-token"
    );
    assert.equal(badCsrf.status, 403);
    assert.equal(badCsrf.json.error.code, "CSRF_INVALID");
    const withCsrf = await cookieApi(
      "POST",
      `/api/meetings/${id}/recording-consent`,
      jar,
      { decision: "approved", noticeVersion: "v1", aiTransfer: "approved" },
      csrfToken
    );
    assert.equal(withCsrf.status, 200);
    const endOk = await cookieApi("POST", `/api/meetings/${id}/end`, jar, {}, csrfToken);
    assert.equal(endOk.status, 200);
    // No Bearer credential path: the same join authorized via an
    // Authorization header is unauthenticated (401), never CSRF-exempt.
    const liveMeeting = await Meeting.create({ title: "csrf-bearer", hostId, status: "live" });
    const bearerJoin = await fetch(`${baseUrl}/api/meetings/${liveMeeting._id}/join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${signAuthToken(hostId)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(bearerJoin.status, 401);
  });

  it("history reaches the oldest meeting past 1,000 memberships", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, memberId]);
    const memberToken = signAuthToken(memberId.toString());
    const N = 1001;
    const createdIds = [];
    for (let i = 0; i < N; i += 1) {
      const meeting = await Meeting.create({ title: `fanin-${i}`, hostId, status: "ended" });
      createdIds.push(meeting._id.toString());
      await MeetingParticipant.create({ meetingId: meeting._id, userId: memberId, status: "admitted" });
    }
    const oldestId = createdIds[0];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 30; page += 1) {
      const path = cursor ? `/api/meetings?limit=50&cursor=${cursor}` : "/api/meetings?limit=50";
      const res = await api("GET", path, memberToken);
      assert.equal(res.status, 200);
      for (const row of res.json.meetings) {
        seen.add(row.id);
      }
      if (!res.json.hasMore) {
        break;
      }
      cursor = res.json.nextCursor;
    }
    assert.ok(seen.has(oldestId), "oldest entitled meeting must be reachable");
    assert.ok(seen.size >= N);
  });

  it("shared Gemini budget binds Phase 4 and Phase 5 jointly", async () => {
    // Phase caps raised so only the shared project cap binds: two
    // calls (one per pipeline) consume a shared budget of 2, and the
    // third call — from either pipeline — fails terminally.
    process.env.TRANSCRIPT_MAX_CALLS_PER_DAY = "1000";
    process.env.INTEL_MAX_CALLS_PER_DAY = "1000";
    process.env.GEMINI_SHARED_MAX_CALLS_PER_DAY = "2";
    resetEnvCache();
    await intelligenceQueue.getConnection().flushdb();
    await transcriptionQueue.takeProviderCallSlot();
    await intelligenceQueue.takeProviderCallSlot();
    await assert.rejects(transcriptionQueue.takeProviderCallSlot(), (err) => err.code === "PROVIDER_QUOTA_EXHAUSTED");
    await assert.rejects(intelligenceQueue.takeProviderCallSlot(), (err) => err.code === "PROVIDER_QUOTA_EXHAUSTED");
    delete process.env.TRANSCRIPT_MAX_CALLS_PER_DAY;
    delete process.env.INTEL_MAX_CALLS_PER_DAY;
    delete process.env.GEMINI_SHARED_MAX_CALLS_PER_DAY;
    resetEnvCache();
  });
});
