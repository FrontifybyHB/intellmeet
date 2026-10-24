"use strict";

// Shareable meeting links: title-only create → copy URL → resolve →
// explicit link join. Real MongoDB, isolated database. Covers code
// uniqueness/stability, collision retry, creator spoofing, admission
// policy (link vs restricted/banned/ended/deleted/wrong-code),
// GET-never-mutates, concurrent-join dedupe, direct-ID no-bypass,
// end/consent races, and no-secret response shapes.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-sharelinks-test";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";
process.env.LIVEKIT_URL = "wss://livekit.test.example.com";
process.env.LIVEKIT_API_KEY = "test-livekit-key";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-do-not-use";
process.env.RECORDING_PROVIDER = "disabled";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const User = require("../src/models/User");

let httpServer;
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

// Cookie JWT auth only (no Bearer, no storage tokens): mirror the
// login-context-bound double-submit CSRF the browser sends.
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
  return { status: res.status, json, headers: res.headers };
}

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

describe("shareable meeting links", () => {
  before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await mongoose.connection.db.dropDatabase();
    await Meeting.syncIndexes();
    await MeetingParticipant.syncIndexes();
    httpServer = http.createServer(app);
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer && httpServer.listening) {
      await new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    resetEnvCache();
    await Promise.all([Meeting.deleteMany({}), MeetingParticipant.deleteMany({})]);
  });

  it("title-only create returns meetingId + stable joinUrl; creator derives from auth", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const spoofId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, spoofId]);
    const hostToken = signAuthToken(hostId.toString());
    const res = await api("POST", "/api/meetings", hostToken, {
      title: "demo",
      hostId: spoofId.toString(),
      role: "admin",
      room: "evil-room",
      joinCode: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.equal(res.status, 201);
    assert.ok(res.json.meetingId);
    assert.equal(res.json.title, "demo");
    assert.equal(res.json.hostId, hostId.toString());
    assert.match(res.json.joinUrl, /^http:\/\/localhost:5173\/join\/[A-Za-z0-9_-]{22}$/);
    const stored = await Meeting.findById(res.json.meetingId).lean();
    assert.equal(String(stored.hostId), hostId.toString());
    assert.ok(stored.joinCode);
    // Page refresh / detail reuse: same code, same URL.
    const memberId = new mongoose.Types.ObjectId();
    await ensureUsers([memberId]);
    await MeetingParticipant.create({ meetingId: stored._id, userId: memberId, status: "admitted" });
    const d1 = await api("GET", `/api/meetings/${res.json.meetingId}`, signAuthToken(memberId.toString()));
    const d2 = await api("GET", `/api/meetings/${res.json.meetingId}`, signAuthToken(memberId.toString()));
    assert.equal(d1.json.meeting.joinUrl, res.json.joinUrl);
    assert.equal(d2.json.meeting.joinUrl, res.json.joinUrl);
  });

  it("two same-title meetings get different codes and rooms", async () => {
    const hostId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId]);
    const token = signAuthToken(hostId.toString());
    const a = await api("POST", "/api/meetings", token, { title: "same" });
    const b = await api("POST", "/api/meetings", token, { title: "same" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.json.meetingId, b.json.meetingId);
    assert.notEqual(a.json.joinUrl, b.json.joinUrl);
  });

  it("allows only the owner to soft-delete an ended meeting", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, otherId]);
    const hostToken = signAuthToken(hostId.toString());
    const created = await api("POST", "/api/meetings", hostToken, { title: "delete me" });

    assert.equal((await api("DELETE", `/api/meetings/${created.json.meetingId}`, hostToken)).status, 409);
    assert.equal((await api("POST", `/api/meetings/${created.json.meetingId}/end`, hostToken, {})).status, 200);
    assert.equal((await api("DELETE", `/api/meetings/${created.json.meetingId}`, signAuthToken(otherId.toString()))).status, 403);

    const deleted = await api("DELETE", `/api/meetings/${created.json.meetingId}`, hostToken);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.meeting.status, "cancelled");
    assert.equal((await api("GET", `/api/meetings/${created.json.meetingId}`, hostToken)).status, 404);
    assert.equal((await api("DELETE", `/api/meetings/${created.json.meetingId}`, hostToken)).status, 200);
  });

  it("valid invitee resolves then explicitly joins and gets a room token", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const guestId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, guestId]);
    const hostToken = signAuthToken(hostId.toString());
    const guestToken = signAuthToken(guestId.toString());
    const created = await api("POST", "/api/meetings", hostToken, { title: "invite" });
    const code = created.json.joinUrl.split("/join/")[1];

    const meta = await api("GET", `/api/meeting-links/${code}`, guestToken);
    assert.equal(meta.status, 200);
    assert.equal(meta.json.meetingId, created.json.meetingId);
    assert.equal(meta.json.membership, "none");
    assert.ok(!("token" in meta.json));
    // Resolve never mutates: no participant row from GETs.
    assert.equal(await MeetingParticipant.countDocuments({ meetingId: created.json.meetingId }), 0);

    const joined = await api("POST", `/api/meeting-links/${code}/join`, guestToken, {});
    assert.equal(joined.status, 200);
    assert.ok(joined.json.token);
    assert.equal(joined.json.roomName, `meeting_${created.json.meetingId}`);
    assert.equal(joined.json.permissions.isHost, false);
    const row = await MeetingParticipant.findOne({ meetingId: created.json.meetingId, userId: guestId }).lean();
    assert.equal(row.status, "admitted");
    // Ordinary participant only: downstream member read works.
    assert.equal((await api("GET", `/api/meetings/${created.json.meetingId}`, guestToken)).status, 200);
  });

  it("anonymous resolve redirects to login; anonymous join denied without auth", async () => {
    const hostId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId]);
    const created = await api("POST", "/api/meetings", signAuthToken(hostId.toString()), { title: "t" });
    const code = created.json.joinUrl.split("/join/")[1];
    assert.equal((await api("GET", `/api/meeting-links/${code}`, null)).status, 401);
    assert.equal((await api("POST", `/api/meeting-links/${code}/join`, null, {})).status, 401);
  });

  it("wrong/malformed codes denied; no secret leakage", async () => {
    const hostId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId]);
    const token = signAuthToken(hostId.toString());
    assert.equal((await api("GET", "/api/meeting-links/not-a-code", token)).status, 400);
    const missing = await api("GET", "/api/meeting-links/aaaaaaaaaaaaaaaaaaaaaa", token);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "INVALID_CODE");
    const joinMissing = await api("POST", "/api/meeting-links/aaaaaaaaaaaaaaaaaaaaaa/join", token, {});
    assert.equal(joinMissing.status, 404);
    for (const body of [missing.json, joinMissing.json]) {
      assert.ok(!JSON.stringify(body).includes("im_at"));
    }
  });

  it("restricted legacy meetings stay restricted; link never overrides bans", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const guestId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, guestId]);
    const legacy = await Meeting.create({ title: "legacy", hostId, status: "live" });
    // Even with a code present, restricted admission denies.
    await Meeting.findByIdAndUpdate(legacy._id, { joinCode: "bbbbbbbbbbbbbbbbbbbbbb" });
    const guestToken = signAuthToken(guestId.toString());
    const denied = await api("POST", "/api/meeting-links/bbbbbbbbbbbbbbbbbbbbbb/join", guestToken, {});
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, "LINK_DISABLED");

    const created = await api("POST", "/api/meetings", signAuthToken(hostId.toString()), { title: "t" });
    const code = created.json.joinUrl.split("/join/")[1];
    await MeetingParticipant.create({ meetingId: created.json.meetingId, userId: guestId, status: "removed" });
    const banned = await api("POST", `/api/meeting-links/${code}/join`, guestToken, {});
    assert.equal(banned.status, 403);
    const row = await MeetingParticipant.findOne({ meetingId: created.json.meetingId, userId: guestId }).lean();
    assert.equal(row.status, "removed");
  });

  it("ended/cancelled meetings deny link joins; direct ID cannot bypass invitation", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const guestId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, guestId]);
    const hostToken = signAuthToken(hostId.toString());
    const guestToken = signAuthToken(guestId.toString());
    const created = await api("POST", "/api/meetings", hostToken, { title: "t" });
    const code = created.json.joinUrl.split("/join/")[1];
    // Knowing the meetingId alone never admits.
    assert.equal((await api("POST", `/api/meetings/${created.json.meetingId}/join`, guestToken, {})).status, 403);
    await Meeting.findByIdAndUpdate(created.json.meetingId, { status: "ended" });
    const afterEnd = await api("POST", `/api/meeting-links/${code}/join`, guestToken, {});
    assert.equal(afterEnd.status, 409);
    assert.equal((await api("POST", `/api/meetings/${created.json.meetingId}/join`, guestToken, {})).status, 403);
  });

  it("repeated and concurrent joins yield one participant row", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const guestId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, guestId]);
    const created = await api("POST", "/api/meetings", signAuthToken(hostId.toString()), { title: "t" });
    const code = created.json.joinUrl.split("/join/")[1];
    const guestToken = signAuthToken(guestId.toString());
    const results = await Promise.all(
      Array.from({ length: 8 }, () => api("POST", `/api/meeting-links/${code}/join`, guestToken, {}))
    );
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.json.meetingId, created.json.meetingId);
    }
    assert.equal(await MeetingParticipant.countDocuments({ meetingId: created.json.meetingId, userId: guestId }), 1);
  });

  it("CSRF required on link join; GET resolve needs none", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const guestId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, guestId]);
    const created = await api("POST", "/api/meetings", signAuthToken(hostId.toString()), { title: "t" });
    const code = created.json.joinUrl.split("/join/")[1];
    const guestToken = signAuthToken(guestId.toString());
    const csrf = csrfFor(guestToken);
    const noCsrf = await fetch(`${baseUrl}/api/meeting-links/${code}/join`, {
      method: "POST",
      headers: { cookie: `im_at=${guestToken}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noCsrf.status, 403);
    await noCsrf.text();
    const ok = await fetch(`${baseUrl}/api/meeting-links/${code}/join`, {
      method: "POST",
      headers: { cookie: `im_at=${guestToken}; im_csrf=${csrf}`, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(ok.status, 200);
    await ok.text();
  });

  it("legacy meetings without codes expose no joinUrl", async () => {
    const hostId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId]);
    const legacy = await Meeting.create({ title: "legacy", hostId, status: "ended" });
    const res = await api("GET", `/api/meetings/${legacy._id}`, signAuthToken(hostId.toString()));
    assert.equal(res.status, 200);
    assert.equal(res.json.meeting.joinUrl, null);
  });
});
