"use strict";

// Focused tests for POST /api/meetings/:id/join.
// No database required: Meeting / MeetingParticipant statics are stubbed
// per test. Auth and LiveKit tokens are HS256 JWTs minted with test secrets.

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";
process.env.LIVEKIT_URL = "wss://livekit.test.example.com";
process.env.LIVEKIT_API_KEY = "test-livekit-key";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-do-not-use";
delete process.env.LIVEKIT_TTL_SECONDS;
// Hermetic provider default: the local .env may set RECORDING_PROVIDER=live.
// These stubbed join tests pin the disabled default they were written
// against (no Recording DB; canPublish=true), mirroring the delete pattern above.
process.env.RECORDING_PROVIDER = "disabled";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const User = require("../src/models/User");

let server;
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

function decodePayload(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "expected a 3-part JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function makeIds() {
  return {
    meetingId: new mongoose.Types.ObjectId(),
    hostId: new mongoose.Types.ObjectId(),
    memberId: new mongoose.Types.ObjectId(),
    strangerId: new mongoose.Types.ObjectId(),
  };
}

let originalFindById;
let originalFindOne;
let originalCreate;
let originalUpdateOne;
let originalUserFindById;

function queryLike(doc) {
  return { lean: async () => doc };
}

function stubDb({ meeting, participant }) {
  Meeting.findById = () => queryLike(meeting);
  MeetingParticipant.findOne = () => queryLike(participant);
  Meeting.create = async () => {
    throw new Error("join must not create records");
  };
  Meeting.updateOne = async () => {
    throw new Error("join must not mutate the meeting");
  };
  MeetingParticipant.create = async () => {
    throw new Error("join must not create membership");
  };
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

function postJoin(meetingId, token, body) {
  return fetch(`${baseUrl}/api/meetings/${meetingId}/join`, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
}

describe("POST /api/meetings/:id/join", () => {
  before(async () => {
    originalFindById = Meeting.findById;
    originalFindOne = MeetingParticipant.findOne;
    originalCreate = Meeting.create;
    originalUpdateOne = Meeting.updateOne;
    originalUserFindById = User.findById;
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    Meeting.findById = originalFindById;
    MeetingParticipant.findOne = originalFindOne;
    User.findById = originalUserFindById;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    resetEnvCache();
    process.env.RECORDING_PROVIDER = "disabled";
    process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";
    process.env.LIVEKIT_URL = "wss://livekit.test.example.com";
    process.env.LIVEKIT_API_KEY = "test-livekit-key";
    process.env.LIVEKIT_API_SECRET = "test-livekit-secret-do-not-use";
    // Stateless auth reads the current User row: stub active/version-0
    // (matches test tokens) so these stay hermetic. Token-policy
    // behavior (purpose/issuer/expiry/version) is exercised for real.
    // Re-apply every test: afterEach restores the original.
    User.findById = () =>
      queryLike({ name: "Asha Sharma", status: "active", role: "user", authVersion: 0 });
  });

  afterEach(() => {
    Meeting.findById = originalFindById;
    MeetingParticipant.findOne = originalFindOne;
    Meeting.create = originalCreate;
    Meeting.updateOne = originalUpdateOne;
    delete MeetingParticipant.create;
    User.findById = originalUserFindById;
  });

  it("issues a token for an admitted member", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: { meetingId, userId: memberId, status: "admitted" },
    });
    const res = await postJoin(meetingId.toString(), signAuthToken(memberId.toString()));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roomName, `meeting_${meetingId.toString()}`);
    assert.equal(body.livekitUrl, "wss://livekit.test.example.com");
    assert.equal(typeof body.token, "string");
    assert.equal(decodePayload(body.token).name, "Asha Sharma");
    assert.deepEqual(body.permissions, {
      isHost: false,
      canRecord: false,
      canScreenShare: true,
    });
  });

  it("issues host permissions from the server-side hostId", async () => {
    const { meetingId, hostId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: null,
    });
    const res = await postJoin(meetingId.toString(), signAuthToken(hostId.toString()));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.permissions.isHost, true);
    assert.equal(body.permissions.canRecord, true);
  });

  it("ignores a client-supplied role", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: { meetingId, userId: memberId, status: "admitted" },
    });
    const res = await postJoin(meetingId.toString(), signAuthToken(memberId.toString()), {
      role: "host",
      isHost: true,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.permissions.isHost, false);
    assert.equal(body.permissions.canRecord, false);
  });

  it("rejects requests without auth", async () => {
    const { meetingId, hostId } = makeIds();
    stubDb({ meeting: { _id: meetingId, hostId, status: "live" }, participant: null });
    const res = await postJoin(meetingId.toString(), null);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  it("rejects malformed meeting ids", async () => {
    const { memberId } = makeIds();
    stubDb({ meeting: null, participant: null });
    const res = await postJoin("not-an-id", signAuthToken(memberId.toString()));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_MEETING_ID");
  });

  it("returns 404 for a missing meeting", async () => {
    const { memberId } = makeIds();
    const missing = new mongoose.Types.ObjectId().toString();
    stubDb({ meeting: null, participant: null });
    const res = await postJoin(missing, signAuthToken(memberId.toString()));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "MEETING_NOT_FOUND");
  });

  it("denies a non-member", async () => {
    const { meetingId, hostId, strangerId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: null,
    });
    const res = await postJoin(meetingId.toString(), signAuthToken(strangerId.toString()));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, "NOT_A_MEMBER");
  });

  it("denies invited and removed members", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    for (const status of ["invited", "removed"]) {
      stubDb({
        meeting: { _id: meetingId, hostId, status: "live" },
        participant: { meetingId, userId: memberId, status },
      });
      const res = await postJoin(
        meetingId.toString(),
        signAuthToken(memberId.toString())
      );
      assert.equal(res.status, 403, `status=${status} should be denied`);
      const body = await res.json();
      assert.equal(body.error.code, "NOT_ADMITTED");
    }
  });

  it("denies ended and cancelled meetings", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    for (const [status, code] of [
      ["ended", "MEETING_ENDED"],
      ["cancelled", "MEETING_CANCELLED"],
    ]) {
      stubDb({
        meeting: { _id: meetingId, hostId, status },
        participant: { meetingId, userId: memberId, status: "admitted" },
      });
      const res = await postJoin(
        meetingId.toString(),
        signAuthToken(memberId.toString())
      );
      assert.equal(res.status, 403, `status=${status} should be denied`);
      const body = await res.json();
      assert.equal(body.error.code, code);
    }
  });

  it("mints short-lived tokens with server-derived claims and media-only grants", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: { meetingId, userId: memberId, status: "admitted" },
    });
    const res = await postJoin(meetingId.toString(), signAuthToken(memberId.toString()));
    assert.equal(res.status, 200);
    const body = await res.json();
    const claims = decodePayload(body.token);
    assert.equal(claims.sub, memberId.toString());
    assert.equal(claims.iss, "test-livekit-key");
    assert.equal(claims.video.room, `meeting_${meetingId.toString()}`);
    assert.equal(claims.video.roomJoin, true);
    assert.equal(claims.video.canPublish, true);
    assert.equal(claims.video.canSubscribe, true);
    assert.equal(claims.video.roomAdmin, false);
    assert.ok(
      claims.exp - claims.iat <= 15 * 60 && claims.exp > claims.iat,
      "token must be short-lived"
    );
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("test-livekit-secret-do-not-use"));
  });

  it("does not query recording consent while issuing a join token", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: { meetingId, userId: memberId, status: "admitted" },
    });
    const Recording = require("../src/models/Recording");
    const originalRecordingFindOne = Recording.findOne;
    let recordingCalls = 0;
    Recording.findOne = () => {
      recordingCalls += 1;
      return { lean: async () => null };
    };
    try {
      const res = await postJoin(meetingId.toString(), signAuthToken(memberId.toString()));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(decodePayload(body.token).video.canPublish, true);
      assert.equal(recordingCalls, 0, "disabled provider must not query Recording");
    } finally {
      Recording.findOne = originalRecordingFindOne;
    }
  });

  it("keeps late joiners publish-capable during a host recording", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: { meetingId, userId: memberId, status: "admitted" },
    });
    process.env.RECORDING_PROVIDER = "mock";
    resetEnvCache();
    const res = await postJoin(meetingId.toString(), signAuthToken(memberId.toString()));
    assert.equal(res.status, 200);
    const claims = decodePayload((await res.json()).token);
    assert.equal(claims.video.canPublish, true);
    assert.equal(claims.video.canPublishData, true);
    process.env.RECORDING_PROVIDER = "disabled";
    resetEnvCache();
  });

  it("repeat joins stay valid and do not mutate membership", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    let findOneCalls = 0;
    let createCalls = 0;
    Meeting.findById = () => queryLike({ _id: meetingId, hostId, status: "live" });
    MeetingParticipant.findOne = () => {
      findOneCalls += 1;
      return queryLike({ meetingId, userId: memberId, status: "admitted" });
    };
    MeetingParticipant.create = async () => {
      createCalls += 1;
      throw new Error("join must not create membership");
    };
    const token = signAuthToken(memberId.toString());
    const first = await postJoin(meetingId.toString(), token);
    const second = await postJoin(meetingId.toString(), token);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json();
    const b = await second.json();
    assert.equal(a.roomName, b.roomName);
    assert.ok(a.token && b.token, "both responses must carry tokens");
    assert.equal(findOneCalls, 2);
    assert.equal(createCalls, 0);
  });

  it("fails closed when the signing secret is missing, without leaking secrets", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    stubDb({
      meeting: { _id: meetingId, hostId, status: "live" },
      participant: { meetingId, userId: memberId, status: "admitted" },
    });
    delete process.env.LIVEKIT_API_SECRET;
    resetEnvCache();
    const logs = [];
    const originalError = console.error;
    console.error = (line) => logs.push(String(line));
    try {
      const res = await postJoin(
        meetingId.toString(),
        signAuthToken(memberId.toString())
      );
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.ok(!text.includes("test-livekit-secret-do-not-use"));
      assert.ok(!logs.join("\n").includes("test-livekit-secret-do-not-use"));
    } finally {
      console.error = originalError;
    }
  });
});
