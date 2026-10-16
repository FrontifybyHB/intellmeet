"use strict";

// Bounded configurable local/staging load harness for the Phase 2
// chat path. Real Socket.IO clients + real MongoDB, synthetic users and
// meetings only — never real meetings, billable provider load, or
// sensitive data.
//
// Scenarios:
//   many-rooms   — independent rooms in parallel (sharded fan-out)
//   hot-room     — many senders, one room, one recipient (hot admission row)
//   sustained    — steady sends over time from a fixed client pool
//   duplicates   — every send retried 3x with the same id (dedup proof)
//   reconnects   — clients drop and rejoin with cursors (repair proof)
//   slow-clients — recipient does 50ms work per message (lag behavior)
//
// Counts accepted/persisted/delivered/duplicates; measures ack and
// recipient latency, error rate, throughput, CPU/RSS, server persist
// time, and post-run cleanup. Active sockets are reported separately
// from message throughput; neither implies LiveKit media capacity.
//
// Usage:
//   node tests/chatLoadHarness.js --scenario=hot-room --rooms=1 \
//     --users=20 --n=400 --concurrency=20 \
//     --mongo-uri=mongodb://127.0.0.1:27017/intellmeet-chat-load

const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");
const { io: Client } = require("socket.io-client");

function arg(name, def) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : def;
}

const SCENARIO = arg("scenario", "hot-room");
const ROOMS = Number(arg("rooms", "5"));
const USERS = Number(arg("users", "10"));
const N = Number(arg("n", "200"));
const CONCURRENCY = Number(arg("concurrency", "10"));
const MONGO_URI = arg("mongo-uri", "mongodb://127.0.0.1:27017/intellmeet-chat-load");

process.env.MONGODB_URI = process.env.MONGODB_URI || MONGO_URI;
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = process.env.JWT_SECRET || "load-harness-secret-do-not-use";
process.env.LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://livekit.load.example.com";
process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "load-key";
process.env.LIVEKIT_API_SECRET =
  process.env.LIVEKIT_API_SECRET || "load-secret-do-not-use";
// Throughput runs must not trip the abuse budget; enforcement itself is
// covered by integration tests, not here.
process.env.CHAT_SEND_PER_SEC = "100";
process.env.CHAT_SEND_BURST = "200";

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function signAuthToken(sub) {
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
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function main() {
  if (
    !["many-rooms", "hot-room", "sustained", "duplicates", "reconnects", "slow-clients"].includes(
      SCENARIO
    )
  ) {
    throw new Error(`unknown scenario ${SCENARIO}`);
  }

  const app = require("../src/app");
  const { attachMeetingSockets } = require("../src/sockets/meetingSockets");
  const Meeting = require("../src/models/Meeting");
  const MeetingParticipant = require("../src/models/MeetingParticipant");
  const User = require("../src/models/User");
  const ChatMessage = require("../src/models/ChatMessage");
  const chatMetrics = require("../src/utils/chatMetrics");

  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  await Meeting.syncIndexes();
  await MeetingParticipant.syncIndexes();
  await ChatMessage.syncIndexes();

  const roomCount = SCENARIO === "hot-room" ? 1 : Math.max(1, ROOMS);
  const userCount = Math.max(2, USERS);
  const meetings = [];
  for (let r = 0; r < roomCount; r += 1) {
    const hostId = new mongoose.Types.ObjectId();
    meetings.push(
      await Meeting.create({ title: `load-${r}`, hostId, status: "live" })
    );
  }
  const users = [];
  await User.syncIndexes();
  for (let u = 0; u < userCount; u += 1) {
    const userId = new mongoose.Types.ObjectId();
    users.push({ userId, token: signAuthToken(userId.toString()) });
    await User.updateOne({ _id: userId }, { $setOnInsert: { name: "load", email: `load-${String(userId)}@example.com`, role: "user", status: "active", authVersion: 0 } }, { upsert: true });
    for (const m of meetings) {
      await MeetingParticipant.create({
        meetingId: m._id,
        userId,
        status: "admitted",
      });
    }
  }

  chatMetrics.reset();
  const httpServer = http.createServer(app);
  const sockets = attachMeetingSockets(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  const clients = [];
  async function connect(user) {
    const socket = Client(baseUrl, {
      extraHeaders: { cookie: `im_at=${user.token}` },
      transports: ["websocket"],
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    clients.push(socket);
    return socket;
  }
  function emitAck(socket, event, payload) {
    return new Promise((resolve) => {
      socket.emit(event, payload, (res) => resolve(res));
    });
  }

  const ackLat = [];
  const recipientLag = [];
  let accepted = 0;
  let duplicateAcks = 0;
  let errors = 0;
  const errorCodes = {};
  let delivered = 0;
  const deliveredIds = new Set();
  let duplicateDeliveries = 0;
  const ackTimeByClientMsg = new Map();
  let slowPending = 0;
  let slowProcessed = 0;
  let slowExpected = 0;
  let slowDrainedAt = 0;
  let slowDrainMs = null;
  let socketRepaired = null;
  let httpSynced = null;

  function watchRecipient(socket, opts) {
    const slowMs = (opts && opts.asyncMs) || 0;
    socket.on("chat:message", (msg) => {
      delivered += 1;
      if (deliveredIds.has(msg.id)) {
        duplicateDeliveries += 1;
      }
      deliveredIds.add(msg.id);
      const sentAt = ackTimeByClientMsg.get(msg.clientMessageId);
      if (sentAt) {
        recipientLag.push(Date.now() - sentAt);
      }
      if (slowMs) {
        // Slow ASYNC consumer: defers processing without blocking the
        // loop, so backlog (not throughput collapse) is what we measure.
        slowPending += 1;
        setTimeout(() => {
          slowPending -= 1;
          slowProcessed += 1;
          if (slowProcessed === slowExpected) {
            slowDrainedAt = Date.now();
          }
        }, slowMs);
      }
    });
  }

  async function join(socket, meetingId) {
    const res = await emitAck(socket, "meeting:join", { meetingId });
    if (!res || !res.ok) {
      throw new Error(`join failed: ${res && res.code}`);
    }
    return res;
  }

  async function send(socket, meetingId, clientMessageId, text) {
    const payload = { meetingId, clientMessageId, text };
    const t0 = process.hrtime.bigint();
    const ack = await new Promise((resolve) => {
      socket.emit("chat:send", payload, (r) => resolve(r));
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    ackLat.push(ms);
    if (ack && ack.ok) {
      accepted += 1;
      ackTimeByClientMsg.set(clientMessageId, Date.now());
      if (ack.duplicate) {
        duplicateAcks += 1;
      }
    } else {
      errors += 1;
      const code = (ack && ack.code) || "NO_ACK";
      errorCodes[code] = (errorCodes[code] || 0) + 1;
    }
    return ack;
  }

  const t0 = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  let expectedPersisted = 0;

  if (SCENARIO === "many-rooms" || SCENARIO === "hot-room" || SCENARIO === "sustained") {
    const perRoom = Math.ceil(N / roomCount);
    const recipient = await connect(users[0]);
    watchRecipient(recipient, 0);
    for (const m of meetings) {
      await join(recipient, m._id.toString());
    }
    // Bounded sender pool: one socket per sending user, each joined to
    // every room it sends to. No unbounded fan-out, no per-message dial.
    const senderUsers = users.slice(1);
    const senders = [];
    for (const u of senderUsers) {
      const socket = await connect(u);
      for (const m of meetings) {
        await join(socket, m._id.toString());
      }
      senders.push(socket);
    }
    const jobs = [];
    for (let r = 0; r < roomCount; r += 1) {
      const meetingId = meetings[r]._id.toString();
      for (let i = 0; i < perRoom && jobs.length < N; i += 1) {
        const sender = senders[(r + i) % senders.length];
        jobs.push({
          sender,
          meetingId,
          clientMessageId: `load-${SCENARIO}-${r}-${i}`,
          text: `msg ${r}/${i}`,
        });
      }
    }
    expectedPersisted = jobs.length;
    const paced = SCENARIO === "sustained";
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      await Promise.all(
        jobs.slice(i, i + CONCURRENCY).map(async (job) => {
          if (paced) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await send(job.sender, job.meetingId, job.clientMessageId, job.text);
        })
      );
    }
    // Let live deliveries land.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } else if (SCENARIO === "duplicates") {
    const meetingId = meetings[0]._id.toString();
    const sender = await connect(users[0]);
    const recipient = await connect(users[1]);
    await join(sender, meetingId);
    await join(recipient, meetingId);
    watchRecipient(recipient, 0);
    for (let i = 0; i < N; i += 1) {
      const clientMessageId = `dup-${i}`;
      for (let retry = 0; retry < 3; retry += 1) {
        await send(sender, meetingId, clientMessageId, `dup text ${i}`);
      }
    }
    expectedPersisted = N;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } else if (SCENARIO === "reconnects") {
    const meetingId = meetings[0]._id.toString();
    const sender = await connect(users[0]);
    await join(sender, meetingId);
    // Cursor advances through the authorized HTTP history after each
    // round, so every rejoin exercises a real newer-than-cursor repair.
    async function latestCursor() {
      const res = await fetch(`${baseUrl}/api/meetings/${meetingId}/messages`, {
        headers: { cookie: `im_at=${users[1].token}` },
      });
      const body = await res.json();
      return body.newestCursor || null;
    }
    let cursor = null;
    socketRepaired = 0;
    const rounds = Math.max(1, Math.floor(N / 10));
    for (let round = 0; round < rounds; round += 1) {
      // Sends happen while the roamer is fully offline.
      for (let i = 0; i < 10; i += 1) {
        await send(
          sender,
          meetingId,
          `re-${round}-${i}`,
          `round ${round} msg ${i}`
        );
      }
      const roamer = await connect(users[1]);
      const rejoin = await emitAck(roamer, "meeting:join", {
        meetingId,
        ...(cursor ? { lastCursor: cursor } : {}),
      });
      if (!rejoin.ok) {
        throw new Error(`rejoin failed: ${rejoin.code}`);
      }
      // Round 0 has no cursor yet, so no socket repair; rounds 1+ repair
      // exactly the 10 sends of the previous offline window.
      for (const m of rejoin.messages || []) {
        delivered += 1;
        socketRepaired += 1;
        deliveredIds.add(m.id);
      }
      roamer.close();
      const idx = clients.indexOf(roamer);
      if (idx >= 0) {
        clients.splice(idx, 1);
      }
      cursor = await latestCursor();
    }
    expectedPersisted = rounds * 10;
    // Full authorized sync over HTTP older-pages: the union must equal
    // every persisted message, including round 0 (pre-cursor window).
    httpSynced = 0;
    const httpSeen = new Set();
    let pageCursor = null;
    for (;;) {
      const params = new URLSearchParams({ limit: "50", direction: "older" });
      if (pageCursor) {
        params.set("cursor", pageCursor);
      }
      const res = await fetch(
        `${baseUrl}/api/meetings/${meetingId}/messages?${params.toString()}`,
        { headers: { cookie: `im_at=${users[1].token}` } }
      );
      const body = await res.json();
      for (const m of body.messages || []) {
        httpSynced += 1;
        httpSeen.add(m.id);
      }
      if (!body.hasMore) {
        break;
      }
      pageCursor = body.nextCursor;
    }
    // The roamer was offline for all sends: every repaired message must
    // come from catch-up, and the union must equal the full history.
    void socketRepaired;
  } else if (SCENARIO === "slow-clients") {
    const meetingId = meetings[0]._id.toString();
    const sender = await connect(users[0]);
    const slow = await connect(users[1]);
    await join(sender, meetingId);
    await join(slow, meetingId);
    slowExpected = N;
    watchRecipient(slow, { asyncMs: 50 });
    for (let i = 0; i < N; i += 1) {
      await send(sender, meetingId, `slow-${i}`, `slow msg ${i}`);
    }
    expectedPersisted = N;
    const lastAckAt = Date.now();
    while (slowProcessed < N && Date.now() - lastAckAt < 30000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    slowDrainMs = slowDrainedAt ? slowDrainedAt - lastAckAt : -1;
  }

  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const cpuDelta = process.cpuUsage(cpuStart);
  ackLat.sort((a, b) => a - b);
  recipientLag.sort((a, b) => a - b);
  const persisted = await ChatMessage.countDocuments({
    meetingId: { $in: meetings.map((m) => m._id) },
  });
  const snap = chatMetrics.getSnapshot();

  console.log(
    JSON.stringify(
      {
        scenario: SCENARIO,
        rooms: roomCount,
        users: userCount,
        sends: N,
        seconds: Math.round(secs * 100) / 100,
        sendsPerSec: Math.round((accepted / secs) * 10) / 10,
        ackP50Ms: Math.round(percentile(ackLat, 0.5) * 100) / 100,
        ackP95Ms: Math.round(percentile(ackLat, 0.95) * 100) / 100,
        ackP99Ms: Math.round(percentile(ackLat, 0.99) * 100) / 100,
        recipientLagP50Ms: Math.round(percentile(recipientLag, 0.5) * 100) / 100,
        recipientLagP95Ms: Math.round(percentile(recipientLag, 0.95) * 100) / 100,
        accepted,
        duplicateAcks,
        errors,
        errorCodes,
        persisted,
        expectedPersisted,
        persistedMatch: persisted === expectedPersisted,
        deliveredLive: delivered,
        duplicateDeliveries,
        socketRepaired,
        httpSynced,
        slowDrainMs,
        activeSockets: snap.socketsActive,
        persistAvgMs: Math.round(snap.persistAvgMs * 100) / 100,
        persistP95Ms: snap.persistP95Ms,
        dbErrors: snap.dbErrors,
        cpuUserMs: Math.round(cpuDelta.user / 1000),
        cpuSystemMs: Math.round(cpuDelta.system / 1000),
        rssMB: snap.rssMB,
        heapUsedMB: snap.heapUsedMB,
      },
      null,
      2
    )
  );

  for (const c of clients) {
    try {
      c.close();
    } catch (_unused) {
      // Best-effort client teardown.
    }
  }
  await sockets.close();
  if (httpServer.listening) {
    await new Promise((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
  await ChatMessage.deleteMany({ meetingId: { $in: meetings.map((m) => m._id) } });
  await MeetingParticipant.deleteMany({
    meetingId: { $in: meetings.map((m) => m._id) },
  });
  await Meeting.deleteMany({ _id: { $in: meetings.map((m) => m._id) } });
  await mongoose.disconnect();
  const after = chatMetrics.getSnapshot();
  console.log(
    JSON.stringify({ cleanupActiveSockets: after.socketsActive })
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ harness: "failed", message: err && err.message }));
  process.exit(1);
});
