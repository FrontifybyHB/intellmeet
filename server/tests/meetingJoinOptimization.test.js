"use strict";

// Regression coverage for the join-path optimization pass.
// No database required: Mongoose statics are stubbed with Query-like
// doubles ({ lean: async () => doc }). Auth and LiveKit tokens are HS256
// JWTs minted with test secrets. Response contract, status codes, and
// error codes must match Phase 1 exactly.

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
delete process.env.JOIN_RATE_LIMIT_MAX;
delete process.env.JOIN_RATE_LIMIT_WINDOW_MS;
// Hermetic provider default: see meetingJoin.test.js (local .env pollution).
process.env.RECORDING_PROVIDER = "disabled";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const joinRateLimit = require("../src/middleware/joinRateLimit");
const metrics = require("../src/utils/joinMetrics");

let server;
let baseUrl;

function signAuthToken(sub) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = {
    sub,
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
  };
}

function queryLike(doc) {
  return { lean: async () => doc };
}

let originalFindById;
let originalFindOne;

function postJoin(meetingId, token) {
  return fetch(`${baseUrl}/api/meetings/${meetingId}/join`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
}

describe("meeting join optimization", () => {
  before(async () => {
    originalFindById = Meeting.findById;
    originalFindOne = MeetingParticipant.findOne;
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    Meeting.findById = originalFindById;
    MeetingParticipant.findOne = originalFindOne;
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
    delete process.env.JOIN_RATE_LIMIT_MAX;
    delete process.env.JOIN_RATE_LIMIT_WINDOW_MS;
    joinRateLimit.resetForTests();
    metrics.reset();
  });

  afterEach(() => {
    Meeting.findById = originalFindById;
    MeetingParticipant.findOne = originalFindOne;
    delete process.env.JOIN_RATE_LIMIT_MAX;
    delete process.env.JOIN_RATE_LIMIT_WINDOW_MS;
    process.env.RECORDING_PROVIDER = "disabled";
    resetEnvCache();
    joinRateLimit.resetForTests();
  });

  it("projects only authorization fields and uses lean()", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    let findByIdArgs;
    let findOneArgs;
    let leaned = 0;
    Meeting.findById = (...args) => {
      findByIdArgs = args;
      return { lean: async () => { leaned += 1; return { _id: meetingId, hostId, status: "live" }; } };
    };
    MeetingParticipant.findOne = (...args) => {
      findOneArgs = args;
      return { lean: async () => { leaned += 1; return { status: "admitted" }; } };
    };
    const res = await postJoin(meetingId.toString(), signAuthToken(memberId.toString()));
    assert.equal(res.status, 200);
    await res.json();
    assert.ok(findByIdArgs, "Meeting.findById must be called");
    assert.ok(findByIdArgs[1] && findByIdArgs[1].hostId === 1, "must project hostId");
    assert.ok(findByIdArgs[1] && findByIdArgs[1].status === 1, "must project status");
    assert.ok(findOneArgs, "MeetingParticipant.findOne must be called");
    assert.deepEqual(Object.keys(findOneArgs[0]).sort(), ["meetingId", "userId"]);
    assert.ok(findOneArgs[1] && findOneArgs[1].status === 1, "must project status");
    assert.equal(leaned, 2, "both reads must use lean()");
  });

  it("marks token responses as non-cacheable", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    Meeting.findById = () => queryLike({ _id: meetingId, hostId, status: "live" });
    MeetingParticipant.findOne = () =>
      queryLike({ meetingId, userId: memberId, status: "admitted" });
    const res = await postJoin(meetingId.toString(), signAuthToken(memberId.toString()));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("pragma"), "no-cache");
    await res.json();
  });

  it("handles simultaneous joins with fresh tokens and no membership writes", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    Meeting.findById = () => queryLike({ _id: meetingId, hostId, status: "live" });
    MeetingParticipant.findOne = () =>
      queryLike({ meetingId, userId: memberId, status: "admitted" });
    MeetingParticipant.create = async () => {
      throw new Error("join must not create membership");
    };
    try {
      const token = signAuthToken(memberId.toString());
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => postJoin(meetingId.toString(), token))
      );
      for (const res of responses) {
        assert.equal(res.status, 200);
      }
      const bodies = await Promise.all(responses.map((r) => r.json()));
      const tokens = bodies.map((b) => b.token);
      assert.equal(new Set(tokens).size, tokens.length, "each join must mint a fresh token");
      for (const body of bodies) {
        assert.equal(body.roomName, `meeting_${meetingId.toString()}`);
        const claims = decodePayload(body.token);
        assert.equal(claims.sub, memberId.toString());
        assert.equal(claims.grants.room, `meeting_${meetingId.toString()}`);
      }
    } finally {
      delete MeetingParticipant.create;
    }
  });

  it("re-reads admission on every join: removal after a first join denies the next", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    Meeting.findById = () => queryLike({ _id: meetingId, hostId, status: "live" });
    let admitted = true;
    MeetingParticipant.findOne = () =>
      queryLike(admitted ? { meetingId, userId: memberId, status: "admitted" } : null);
    const token = signAuthToken(memberId.toString());
    const first = await postJoin(meetingId.toString(), token);
    assert.equal(first.status, 200);
    await first.json();
    admitted = false; // membership revoked server-side between joins
    const second = await postJoin(meetingId.toString(), token);
    assert.equal(second.status, 403);
    const body = await second.json();
    assert.equal(body.error.code, "NOT_A_MEMBER");
  });

  it("fails closed on DB errors without leaking secrets", async () => {
    const { memberId } = makeIds();
    const missing = new mongoose.Types.ObjectId().toString();
    Meeting.findById = () => ({
      lean: async () => {
        throw new Error("boom");
      },
    });
    const logs = [];
    const originalError = console.error;
    console.error = (line) => logs.push(String(line));
    try {
      const res = await postJoin(missing, signAuthToken(memberId.toString()));
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.ok(!text.includes("boom"), "must not leak driver details");
      assert.ok(!text.includes("test-livekit-secret-do-not-use"));
      assert.ok(!logs.join("\n").includes("test-livekit-secret-do-not-use"));
    } finally {
      console.error = originalError;
    }
  });

  it("rate-limits join bursts per user+meeting but spares other meetings", async () => {
    process.env.JOIN_RATE_LIMIT_MAX = "3";
    resetEnvCache();
    const { hostId, memberId } = makeIds();
    const roomA = new mongoose.Types.ObjectId();
    const roomB = new mongoose.Types.ObjectId();
    Meeting.findById = (id) => queryLike({ _id: id, hostId, status: "live" });
    MeetingParticipant.findOne = () => queryLike({ status: "admitted" });
    const token = signAuthToken(memberId.toString());
    const firstThree = await Promise.all(
      [1, 2, 3].map(() => postJoin(roomA.toString(), token))
    );
    for (const res of firstThree) {
      assert.equal(res.status, 200);
      await res.json();
    }
    const limited = await postJoin(roomA.toString(), token);
    assert.equal(limited.status, 429);
    const limitedBody = await limited.json();
    assert.equal(limitedBody.error.code, "RATE_LIMITED");
    assert.ok(limited.headers.get("retry-after"), "must send Retry-After");
    // Same user, different meeting: per-meeting bucket is independent.
    const other = await postJoin(roomB.toString(), token);
    assert.equal(other.status, 200);
    await other.json();
    const snap = metrics.getSnapshot();
    assert.equal(snap.rateLimited, 1);
  });

  it("records low-cardinality metrics without per-user labels", async () => {
    const { meetingId, hostId, memberId } = makeIds();
    Meeting.findById = () => queryLike({ _id: meetingId, hostId, status: "live" });
    MeetingParticipant.findOne = () =>
      queryLike({ meetingId, userId: memberId, status: "admitted" });
    const token = signAuthToken(memberId.toString());
    const okRes = await postJoin(meetingId.toString(), token);
    assert.equal(okRes.status, 200);
    await okRes.json();
    const denied = await postJoin(meetingId.toString(), null);
    assert.equal(denied.status, 401);
    await denied.json();
    const snap = metrics.getSnapshot();
    assert.equal(snap.joins, 1, "only the join handler observes, not auth rejects");
    assert.equal(snap.ok, 1);
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes(memberId.toString()), "no per-user labels");
    assert.ok(!serialized.includes(meetingId.toString()), "no per-meeting labels");
    assert.ok(snap.approxP50Ms >= 0 && snap.approxP95Ms >= snap.approxP50Ms);
    assert.ok(snap.rssMB > 0);
  });
});
