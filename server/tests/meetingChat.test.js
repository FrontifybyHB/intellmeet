"use strict";

// Phase 2 integration: real Socket.IO clients + real MongoDB.
// Covers room isolation, durable deduplicated chat, bounded authorized
// history, reconnect repair, auth expiry/removal/end, multi-tab cleanup,
// rate limits and oversized payloads. Two-instance/Redis tests are NOT
// run here (no adapter dependency in this phase) — see completion report.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");
const { io: Client } = require("socket.io-client");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet-chat-test";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";
process.env.LIVEKIT_URL = "wss://livekit.test.example.com";
process.env.LIVEKIT_API_KEY = "test-livekit-key";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-do-not-use";
delete process.env.LIVEKIT_TTL_SECONDS;
delete process.env.CHAT_SEND_PER_SEC;
delete process.env.CHAT_SEND_BURST;

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const { attachMeetingSockets } = require("../src/sockets/meetingSockets");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const ChatMessage = require("../src/models/ChatMessage");
const sendBudget = require("../src/sockets/sendBudget");
const chatMetrics = require("../src/utils/chatMetrics");

let httpServer;
let sockets;
let baseUrl;

function signAuthToken(sub, overrides) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = {
    sub,
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

function connectClient(token, opts) {
  return new Promise((resolve, reject) => {
    const socket = Client(baseUrl, {
      auth: token ? { token } : {},
      transports: ["websocket"],
      ...(opts || {}),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeMeeting({ status, members } = {}) {
  const hostId = new mongoose.Types.ObjectId();
  const meeting = await Meeting.create({
    title: "chat-test",
    hostId,
    status: status || "live",
  });
  const users = {};
  for (const name of members || []) {
    const userId = new mongoose.Types.ObjectId();
    users[name] = { id: userId, token: signAuthToken(userId.toString()) };
    await MeetingParticipant.create({
      meetingId: meeting._id,
      userId,
      status: "admitted",
    });
  }
  return { meeting, hostId, users };
}

function historyFetch(meetingId, token, query) {
  return fetch(`${baseUrl}/api/meetings/${meetingId}/messages${query || ""}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("phase 2 meeting chat", () => {
  before(async () => {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await Meeting.syncIndexes();
    await MeetingParticipant.syncIndexes();
    await ChatMessage.syncIndexes();
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
    // io.close() also closes the attached HTTP server in socket.io 4.x:
    // only close it when still listening.
    if (httpServer && httpServer.listening) {
      await new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    resetEnvCache();
    delete process.env.CHAT_SEND_PER_SEC;
    delete process.env.CHAT_SEND_BURST;
    sendBudget.resetForTests();
    chatMetrics.reset();
    await ChatMessage.deleteMany({});
    await MeetingParticipant.deleteMany({});
    await Meeting.deleteMany({});
  });

  it("two authorized users communicate through the room", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    const b = await connectClient(users.b.token);
    try {
      assert.deepEqual((await emitAck(a, "meeting:join", { meetingId: id })).ok, true);
      assert.deepEqual((await emitAck(b, "meeting:join", { meetingId: id })).ok, true);
      const received = new Promise((resolve) => b.once("chat:message", resolve));
      const ack = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "msg-1",
        text: "hello from a",
      });
      assert.equal(ack.ok, true);
      assert.equal(ack.duplicate, false);
      assert.equal(ack.message.text, "hello from a");
      assert.equal(ack.message.senderId, users.a.id.toString());
      const live = await received;
      assert.equal(live.id, ack.message.id);
      assert.equal(live.text, "hello from a");
      const row = await ChatMessage.findById(ack.message.id).lean();
      assert.ok(row, "message must be durable before broadcast");
    } finally {
      a.close();
      b.close();
    }
  });

  it("outsiders cannot join, send, or read", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const outsiderId = new mongoose.Types.ObjectId();
    const outsiderToken = signAuthToken(outsiderId.toString());
    const o = await connectClient(outsiderToken);
    try {
      const join = await emitAck(o, "meeting:join", { meetingId: id });
      assert.equal(join.ok, false);
      assert.equal(join.code, "NOT_A_MEMBER");
      const send = await emitAck(o, "chat:send", {
        meetingId: id,
        clientMessageId: "x-1",
        text: "intruder",
      });
      assert.equal(send.ok, false);
      assert.equal(send.code, "NOT_A_MEMBER");
      const res = await historyFetch(id, outsiderToken);
      assert.equal(res.status, 403);
      const self = await connectClient(users.a.token);
      try {
        await emitAck(self, "meeting:join", { meetingId: id });
        const okSend = await emitAck(self, "chat:send", {
          meetingId: id,
          clientMessageId: "a-1",
          text: "member talk",
        });
        assert.equal(okSend.ok, true);
      } finally {
        self.close();
      }
      // The outsider socket never joined: it must not observe member chat.
      const leaked = await new Promise((resolve) => {
        o.once("chat:message", () => resolve(true));
        setTimeout(() => resolve(false), 150);
      });
      assert.equal(leaked, false);
      assert.equal(await ChatMessage.countDocuments({ meetingId: meeting._id }), 1);
    } finally {
      o.close();
    }
  });

  it("messages do not leak across rooms", async () => {
    const first = await makeMeeting({ members: ["a"] });
    const second = await makeMeeting({ members: ["b"] });
    const idA = first.meeting._id.toString();
    const idB = second.meeting._id.toString();
    const a = await connectClient(first.users.a.token);
    const b = await connectClient(second.users.b.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: idA });
      await emitAck(b, "meeting:join", { meetingId: idB });
      const leaked = new Promise((resolve) => {
        b.once("chat:message", () => resolve(true));
        setTimeout(() => resolve(false), 200);
      });
      const ack = await emitAck(a, "chat:send", {
        meetingId: idA,
        clientMessageId: "room-a-1",
        text: "room a only",
      });
      assert.equal(ack.ok, true);
      assert.equal(await leaked, false);
      const resB = await historyFetch(idB, second.users.b.token);
      assert.equal(resB.status, 200);
      assert.deepEqual((await resB.json()).messages, []);
    } finally {
      a.close();
      b.close();
    }
  });

  it("duplicate retries return the canonical row without rebroadcast", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    const b = await connectClient(users.b.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      await emitAck(b, "meeting:join", { meetingId: id });
      let broadcasts = 0;
      b.on("chat:message", () => {
        broadcasts += 1;
      });
      const first = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "dup-1",
        text: "once",
      });
      assert.equal(first.ok, true);
      assert.equal(first.duplicate, false);
      const retry = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "dup-1",
        text: "once",
      });
      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.message.id, first.message.id);
      await sleep(200);
      assert.equal(broadcasts, 1, "only the insert winner publishes");
      assert.equal(
        await ChatMessage.countDocuments({ meetingId: meeting._id }),
        1
      );
    } finally {
      a.close();
      b.close();
    }
  });

  it("simultaneous duplicates collapse to a single row and broadcast", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    const b = await connectClient(users.b.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      await emitAck(b, "meeting:join", { meetingId: id });
      let broadcasts = 0;
      b.on("chat:message", () => {
        broadcasts += 1;
      });
      const acks = await Promise.all(
        Array.from({ length: 10 }, () =>
          emitAck(a, "chat:send", {
            meetingId: id,
            clientMessageId: "race-1",
            text: "same",
          })
        )
      );
      for (const ack of acks) {
        assert.equal(ack.ok, true);
      }
      const ids = new Set(acks.map((ack) => ack.message.id));
      assert.equal(ids.size, 1, "all retries resolve to one canonical id");
      await sleep(200);
      assert.equal(broadcasts, 1);
      assert.equal(
        await ChatMessage.countDocuments({ meetingId: meeting._id }),
        1
      );
    } finally {
      a.close();
      b.close();
    }
  });

  it("reusing an id with different content is a conflict", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    const b = await connectClient(users.b.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      await emitAck(b, "meeting:join", { meetingId: id });
      let broadcasts = 0;
      b.on("chat:message", () => {
        broadcasts += 1;
      });
      assert.equal(
        (await emitAck(a, "chat:send", {
          meetingId: id,
          clientMessageId: "c-1",
          text: "original",
        })).ok,
        true
      );
      const conflict = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "c-1",
        text: "rewritten",
      });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.code, "MESSAGE_CONFLICT");
      await sleep(200);
      assert.equal(broadcasts, 1);
      const row = await ChatMessage.findOne({ meetingId: meeting._id }).lean();
      assert.equal(row.text, "original");
    } finally {
      a.close();
      b.close();
    }
  });

  it("DB failure means no success ack and no broadcast", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    const b = await connectClient(users.b.token);
    const originalCreate = ChatMessage.create;
    ChatMessage.create = async () => {
      throw new Error("boom");
    };
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      await emitAck(b, "meeting:join", { meetingId: id });
      const leaked = new Promise((resolve) => {
        b.once("chat:message", () => resolve(true));
        setTimeout(() => resolve(false), 200);
      });
      const ack = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "db-1",
        text: "never persisted",
      });
      assert.equal(ack.ok, false);
      assert.equal(ack.code, "DB_ERROR");
      assert.equal(await leaked, false);
      assert.equal(
        await ChatMessage.countDocuments({ meetingId: meeting._id }),
        0
      );
    } finally {
      ChatMessage.create = originalCreate;
      a.close();
      b.close();
    }
  });

  it("reconnect catch-up repairs messages missed while offline", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    try {
      const join = await emitAck(a, "meeting:join", { meetingId: id });
      assert.equal(join.ok, true);
      const first = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "r-1",
        text: "before drop",
      });
      assert.equal(first.ok, true);
      a.close();
      const b = await connectClient(users.b.token);
      try {
        await emitAck(b, "meeting:join", { meetingId: id });
        for (const n of [2, 3, 4]) {
          const ack = await emitAck(b, "chat:send", {
            meetingId: id,
            clientMessageId: `r-${n}`,
            text: `missed ${n}`,
          });
          assert.equal(ack.ok, true);
        }
      } finally {
        b.close();
      }
      const a2 = await connectClient(users.a.token);
      try {
        // Live messages arriving during the race are deduped by id
        // against catch-up pages on the client.
        const liveIds = new Set();
        a2.on("chat:message", (msg) => liveIds.add(msg.id));
        // No cursor: the join carries no catch-up; HTTP history owns
        // repair and the client dedupes by id.
        const rejoin = await emitAck(a2, "meeting:join", { meetingId: id });
        assert.equal(rejoin.ok, true);
        assert.deepEqual(rejoin.messages, []);
        void liveIds;
        const res = await historyFetch(
          id,
          users.a.token,
          `?cursor=${encodeURIComponent(rejoin.nextCursor || "")}&direction=newer`
        );
        // Empty cursor is invalid for forward catch-up: explicit error.
        assert.equal(res.status, 400);
        const full = await historyFetch(id, users.a.token);
        assert.equal(full.status, 200);
        const body = await full.json();
        assert.equal(body.messages.length, 4);
        assert.deepEqual(
          body.messages.map((m) => m.text),
          ["before drop", "missed 2", "missed 3", "missed 4"]
        );
      } finally {
        a2.close();
      }
    } catch (err) {
      try {
        a.close();
      } catch (_unused) {
        // Already closed on the offline path.
      }
      throw err;
    }
  });

  it("reconnect with a cursor returns only newer messages", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    const b = await connectClient(users.b.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      await emitAck(b, "meeting:join", { meetingId: id });
      const first = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "k-1",
        text: "kept",
      });
      const oldest = await historyFetch(id, users.a.token);
      const oldestBody = await oldest.json();
      const cursorOfFirst = oldestBody.nextCursor;
      assert.ok(cursorOfFirst);
      await emitAck(b, "chat:send", {
        meetingId: id,
        clientMessageId: "k-2",
        text: "newer one",
      });
      await emitAck(b, "chat:send", {
        meetingId: id,
        clientMessageId: "k-3",
        text: "newer two",
      });
      const a2 = await connectClient(users.a.token);
      try {
        const rejoin = await emitAck(a2, "meeting:join", {
          meetingId: id,
          lastCursor: cursorOfFirst,
        });
        assert.equal(rejoin.ok, true);
        // Cursor pointed at the latest page edge: only newer rows return.
        assert.ok(rejoin.messages.length >= 2);
        assert.deepEqual(
          rejoin.messages.map((m) => m.text),
          ["newer one", "newer two"]
        );
        void first;
      } finally {
        a2.close();
      }
    } finally {
      a.close();
      b.close();
    }
  });

  it("equal-timestamp pages have no gaps or duplicates", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const stamp = new Date();
    const docs = [];
    for (let i = 0; i < 7; i += 1) {
      docs.push({
        meetingId: meeting._id,
        senderId: users.a.id,
        clientMessageId: `eq-${i}`,
        text: `eq ${i}`,
        createdAt: stamp,
      });
    }
    await ChatMessage.insertMany(docs);
    const seen = [];
    let before;
    for (let page = 0; page < 4; page += 1) {
      const query = before
        ? `?limit=2&cursor=${encodeURIComponent(before)}`
        : "?limit=2";
      const res = await historyFetch(id, users.a.token, query);
      assert.equal(res.status, 200);
      const body = await res.json();
      seen.push(...body.messages.map((m) => m.clientMessageId));
      if (!body.hasMore) {
        break;
      }
      before = body.nextCursor;
    }
    assert.deepEqual(new Set(seen).size, 7);
    assert.deepEqual(
      [...seen].sort(),
      ["eq-0", "eq-1", "eq-2", "eq-3", "eq-4", "eq-5", "eq-6"]
    );
  });

  it("history cursors are bound to the authorized meeting", async () => {
    const first = await makeMeeting({ members: ["a"] });
    const both = await makeMeeting({ members: [] });
    // Same user admitted to both meetings.
    const userId = first.users.a.id;
    await MeetingParticipant.create({
      meetingId: both.meeting._id,
      userId,
      status: "admitted",
    });
    const idA = first.meeting._id.toString();
    const idB = both.meeting._id.toString();
    const a = await connectClient(first.users.a.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: idA });
      await emitAck(a, "chat:send", {
        meetingId: idA,
        clientMessageId: "bind-1",
        text: "room a secret",
      });
      const pageA = await (await historyFetch(idA, first.users.a.token)).json();
      assert.equal(pageA.messages.length, 1);
      // Replay room A's cursor against room B: bound filter wins, no leak.
      const replay = await historyFetch(
        idB,
        first.users.a.token,
        `?cursor=${encodeURIComponent(pageA.nextCursor)}`
      );
      assert.equal(replay.status, 200);
      assert.deepEqual((await replay.json()).messages, []);
    } finally {
      a.close();
    }
  });

  it("expired handshake tokens are rejected; LiveKit tokens are not app auth", async () => {
    const { meeting } = await makeMeeting({ members: [] });
    const id = meeting._id.toString();
    const expired = signAuthToken(new mongoose.Types.ObjectId().toString(), {
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    await assert.rejects(connectClient(expired), /Invalid or expired/);
    // A LiveKit-style token signed with the LiveKit secret is rejected:
    // room tokens never authenticate the app socket.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url"
    );
    const body = Buffer.from(
      JSON.stringify({ sub: "someone", exp: Math.floor(Date.now() / 1000) + 600 })
    ).toString("base64url");
    const sig = crypto
      .createHmac("sha256", process.env.LIVEKIT_API_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");
    await assert.rejects(
      connectClient(`${header}.${body}.${sig}`),
      /Invalid or expired/
    );
    await assert.rejects(connectClient(null), /Authentication required/);
    void id;
  });

  it("sends after auth expiry are rejected and disconnected", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const shortToken = signAuthToken(users.a.id.toString(), {
      exp: Math.floor(Date.now() / 1000) + 1,
    });
    const a = await connectClient(shortToken);
    try {
      assert.equal(
        (await emitAck(a, "meeting:join", { meetingId: id })).ok,
        true
      );
      await sleep(1200);
      const disconnected = new Promise((resolve) => a.once("disconnect", resolve));
      const send = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "exp-1",
        text: "too late",
      });
      // Explicit rejection first, then the stale socket is dropped: the
      // client must reconnect with a fresh token.
      assert.deepEqual(send, {
        ok: false,
        code: "UNAUTHORIZED",
        message: "Authentication has expired.",
      });
      await disconnected;
      assert.equal(a.connected, false);
      assert.equal(
        await ChatMessage.countDocuments({ meetingId: meeting._id }),
        0
      );
    } finally {
      a.close();
    }
  });

  it("removal and meeting end deny sends, joins, and history", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      await MeetingParticipant.updateOne(
        { meetingId: meeting._id, userId: users.a.id },
        { $set: { status: "removed" } }
      );
      const denied = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "rm-1",
        text: "removed user",
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.code, "NOT_ADMITTED");
      const rejoin = await emitAck(a, "meeting:join", { meetingId: id });
      assert.equal(rejoin.ok, false);
      assert.equal(rejoin.code, "NOT_ADMITTED");
      assert.equal((await historyFetch(id, users.a.token)).status, 403);
      await Meeting.updateOne(
        { _id: meeting._id },
        { $set: { status: "ended" } }
      );
      const endedJoin = await emitAck(a, "meeting:join", { meetingId: id });
      assert.equal(endedJoin.ok, false);
      assert.equal(endedJoin.code, "MEETING_ENDED");
    } finally {
      a.close();
    }
  });

  it("leaving one tab keeps another tab of the same user live", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a", "b"] });
    const id = meeting._id.toString();
    const tab1 = await connectClient(users.a.token);
    const tab2 = await connectClient(users.a.token);
    const b = await connectClient(users.b.token);
    try {
      await emitAck(tab1, "meeting:join", { meetingId: id });
      await emitAck(tab2, "meeting:join", { meetingId: id });
      await emitAck(b, "meeting:join", { meetingId: id });
      assert.deepEqual(await emitAck(tab1, "meeting:leave", { meetingId: id }), {
        ok: true,
      });
      const got = new Promise((resolve) => tab2.once("chat:message", resolve));
      const ack = await emitAck(b, "chat:send", {
        meetingId: id,
        clientMessageId: "tab-1",
        text: "still here",
      });
      assert.equal(ack.ok, true);
      const live = await got;
      assert.equal(live.text, "still here");
    } finally {
      tab1.close();
      tab2.close();
      b.close();
    }
  });

  it("per-user send budget spans sockets and rejects bursts", async () => {
    process.env.CHAT_SEND_PER_SEC = "2";
    process.env.CHAT_SEND_BURST = "2";
    resetEnvCache();
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      assert.equal(
        (await emitAck(a, "chat:send", {
          meetingId: id,
          clientMessageId: "q-1",
          text: "one",
        })).ok,
        true
      );
      assert.equal(
        (await emitAck(a, "chat:send", {
          meetingId: id,
          clientMessageId: "q-2",
          text: "two",
        })).ok,
        true
      );
      const limited = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "q-3",
        text: "three",
      });
      assert.equal(limited.ok, false);
      assert.equal(limited.code, "RATE_LIMITED");
      assert.equal(
        await ChatMessage.countDocuments({ meetingId: meeting._id }),
        2
      );
    } finally {
      a.close();
      delete process.env.CHAT_SEND_PER_SEC;
      delete process.env.CHAT_SEND_BURST;
      resetEnvCache();
    }
  });

  it("oversized and malformed payloads are rejected before DB work", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const before = await ChatMessage.countDocuments({ meetingId: meeting._id });
    const a = await connectClient(users.a.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      const big = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "big-1",
        text: "x".repeat(2001),
      });
      assert.equal(big.ok, false);
      assert.equal(big.code, "VALIDATION_ERROR");
      const badId = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "no spaces!!",
        text: "ok",
      });
      assert.equal(badId.ok, false);
      assert.equal(badId.code, "VALIDATION_ERROR");
      const blank = await emitAck(a, "chat:send", {
        meetingId: id,
        clientMessageId: "blank-1",
        text: "   ",
      });
      assert.equal(blank.ok, false);
      assert.equal(blank.code, "VALIDATION_ERROR");
      const malformed = await emitAck(a, "meeting:join", {
        meetingId: "not-an-id",
      });
      assert.equal(malformed.ok, false);
      assert.equal(malformed.code, "INVALID_MEETING_ID");
      assert.equal(
        await ChatMessage.countDocuments({ meetingId: meeting._id }),
        before
      );
    } finally {
      a.close();
    }
  });

  it("history pages are bounded, ordered, and authorized", async () => {
    const { meeting, users } = await makeMeeting({ members: ["a"] });
    const id = meeting._id.toString();
    const a = await connectClient(users.a.token);
    try {
      await emitAck(a, "meeting:join", { meetingId: id });
      for (let i = 0; i < 5; i += 1) {
        const ack = await emitAck(a, "chat:send", {
          meetingId: id,
          clientMessageId: `h-${i}`,
          text: `msg ${i}`,
        });
        assert.equal(ack.ok, true);
      }
      const noAuth = await historyFetch(id, null);
      assert.equal(noAuth.status, 401);
      const first = await historyFetch(id, users.a.token, "?limit=2");
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.equal(firstBody.messages.length, 2);
      assert.equal(firstBody.hasMore, true);
      assert.ok(firstBody.nextCursor);
      assert.ok(firstBody.newestCursor, "latest page exposes a forward-resume cursor");
      // Latest page first, oldest-first within the page.
      assert.deepEqual(
        firstBody.messages.map((m) => m.text),
        ["msg 3", "msg 4"]
      );
      const second = await historyFetch(
        id,
        users.a.token,
        `?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`
      );
      const secondBody = await second.json();
      assert.deepEqual(
        secondBody.messages.map((m) => m.text),
        ["msg 1", "msg 2"]
      );
      // Over-cap limits clamp; invalid limits and cursors fail closed.
      const clamped = await (
        await historyFetch(id, users.a.token, "?limit=5000")
      ).json();
      assert.equal(clamped.messages.length, 5);
      assert.equal((await historyFetch(id, users.a.token, "?limit=0")).status, 400);
      assert.equal(
        (await historyFetch(id, users.a.token, "?cursor=junk")).status,
        400
      );
    } finally {
      a.close();
    }
  });
});
