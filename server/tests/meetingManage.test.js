"use strict";

// Provisional meeting management (create + admit) so the whole flow is
// exercisable end to end via API. Real MongoDB, isolated database.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-manage-test";
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

describe("provisional meeting management", () => {
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

  it("host creates a meeting and admits a member who can then join", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, memberId]);
    const hostToken = signAuthToken(hostId.toString());
    const memberToken = signAuthToken(memberId.toString());

    const created = await api("POST", "/api/meetings", hostToken, { title: "demo" });
    assert.equal(created.status, 201);
    assert.ok(created.json.id);

    // Member cannot join before admission.
    assert.equal((await api("POST", `/api/meetings/${created.json.id}/join`, memberToken, {})).status, 403);

    const admitted = await api("POST", `/api/meetings/${created.json.id}/members`, hostToken, {
      userId: memberId.toString(),
    });
    assert.equal(admitted.status, 200);

    const join = await api("POST", `/api/meetings/${created.json.id}/join`, memberToken, {});
    assert.equal(join.status, 200);
    assert.ok(join.json.token);
  });

  it("creation needs auth; admission is host-only and validates ids", async () => {
    const hostId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId, otherId]);
    const hostToken = signAuthToken(hostId.toString());
    const otherToken = signAuthToken(otherId.toString());

    assert.equal((await api("POST", "/api/meetings", null, { title: "x" })).status, 401);
    const created = await api("POST", "/api/meetings", hostToken, { title: "demo" });
    assert.equal(created.status, 201);
    assert.equal(
      (await api("POST", `/api/meetings/${created.json.id}/members`, otherToken, { userId: otherId.toString() })).status,
      403
    );
    assert.equal(
      (await api("POST", `/api/meetings/${created.json.id}/members`, hostToken, { userId: "not-an-id" })).status,
      400
    );
  });

  it("keeps future meetings scheduled until their host starts them", async () => {
    const hostId = new mongoose.Types.ObjectId();
    await ensureUsers([hostId]);
    const token = signAuthToken(hostId.toString());
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await api("POST", "/api/meetings", token, {
      title: "scheduled demo",
      scheduledAt,
      timezone: "Asia/Kolkata",
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.status, "scheduled");
    assert.equal((await api("POST", `/api/meetings/${created.json.id}/join`, token, {})).status, 409);
    const started = await api("POST", `/api/meetings/${created.json.id}/start`, token, {});
    assert.equal(started.status, 200);
    assert.equal(started.json.meeting.status, "live");
  });
});
