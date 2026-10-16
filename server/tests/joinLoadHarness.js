"use strict";

// Configurable local/staging load harness for POST /api/meetings/:id/join.
//
// Compares join throughput/latency across scenarios on the same
// hardware/data/settings. Synthetic users and meetings only — never run
// against real meetings, billable provider load, or sensitive data.
//
// Scenarios:
//   many-rooms  — requests spread across --rooms meetings (sharded load)
//   hot-room    — every request joins ONE meeting (single hot admission row)
//   reconnect   — --users users re-join one meeting --repeats times each
//
// Modes:
//   stubbed — Mongoose reads stubbed (measures Express + auth + signing)
//   realdb  — real MongoDB fixtures + indexed reads + atomic paths
//
// Usage:
//   node tests/joinLoadHarness.js --mode=stubbed --scenario=hot-room \
//     --n=500 --concurrency=50
//   node tests/joinLoadHarness.js --mode=realdb --scenario=many-rooms \
//     --n=1000 --concurrency=50 --rooms=20 --users=20 \
//     --mongo-uri=mongodb://127.0.0.1:27017/intellmeet-load
//
// An issued token does NOT prove media connection or presence; this
// harness measures HTTP token issuance only, not LiveKit media capacity.

const crypto = require("node:crypto");
const mongoose = require("mongoose");

function arg(name, def) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : def;
}

const MODE = arg("mode", "stubbed");
const SCENARIO = arg("scenario", "hot-room");
const N = Number(arg("n", "500"));
const CONCURRENCY = Number(arg("concurrency", "50"));
const ROOMS = Number(arg("rooms", "10"));
const USERS = Number(arg("users", "10"));
const REPEATS = Number(arg("repeats", "5"));
const MONGO_URI = arg("mongo-uri", "mongodb://127.0.0.1:27017/intellmeet-load");
// Throughput runs use distinct synthetic users so the abuse limiter does
// not mask join cost; pass --rate-limit-max=30 to exercise enforcement.
const RATE_LIMIT_MAX = arg("rate-limit-max", "1000");

process.env.MONGODB_URI = process.env.MONGODB_URI || MONGO_URI;
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = process.env.JWT_SECRET || "load-harness-secret-do-not-use";
process.env.LIVEKIT_URL =
  process.env.LIVEKIT_URL || "wss://livekit.load.example.com";
process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "load-key";
process.env.LIVEKIT_API_SECRET =
  process.env.LIVEKIT_API_SECRET || "load-secret-do-not-use";
process.env.JOIN_RATE_LIMIT_MAX = RATE_LIMIT_MAX;
delete process.env.JOIN_RATE_LIMIT_WINDOW_MS;
// Hermetic provider default: a local .env with RECORDING_PROVIDER=live would
// otherwise force every stubbed join through a 10s mongoose-buffered
// Recording probe. Throughput runs measure Express+auth+signing; pass
// --recording-provider=mock|live explicitly to exercise consent gating.
if (!process.argv.some((a) => a.startsWith("--recording-provider="))) {
  process.env.RECORDING_PROVIDER = "disabled";
} else {
  process.env.RECORDING_PROVIDER = arg("recording-provider", "disabled");
}

const { resetEnvCache } = require("../src/config/env");

resetEnvCache();

const app = require("../src/app");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const metrics = require("../src/utils/joinMetrics");
const joinRateLimit = require("../src/middleware/joinRateLimit");

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

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function main() {
  if (!["stubbed", "realdb"].includes(MODE)) throw new Error(`unknown mode ${MODE}`);
  if (!["many-rooms", "hot-room", "reconnect"].includes(SCENARIO)) {
    throw new Error(`unknown scenario ${SCENARIO}`);
  }

  let dbQueries = 0;
  let cleanup = async () => {};
  const plan = []; // { meetingId: string, userId: string, token: string }

  if (MODE === "stubbed") {
    const hostId = new mongoose.Types.ObjectId();
    // One meeting per --rooms for many-rooms; a single hot meeting
    // otherwise. Every request uses a distinct synthetic user so the
    // per-user+meeting limiter does not mask join cost.
    const roomCount = SCENARIO === "many-rooms" ? Math.max(1, ROOMS) : 1;
    const meetingIds = Array.from(
      { length: roomCount },
      () => new mongoose.Types.ObjectId()
    );
    const admitted = { status: "admitted" };
    Meeting.findById = (id) => {
      dbQueries += 1;
      const found = meetingIds.find((m) => String(m) === String(id));
      return {
        lean: async () => (found ? { _id: found, hostId, status: "live" } : null),
      };
    };
    MeetingParticipant.findOne = () => {
      dbQueries += 1;
      return { lean: async () => admitted };
    };
    for (let i = 0; i < N; i += 1) {
      const userId = new mongoose.Types.ObjectId();
      plan.push({
        meetingId: meetingIds[i % meetingIds.length].toString(),
        token: signAuthToken(userId.toString()),
      });
    }
    cleanup = async () => {};
  } else {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await Meeting.syncIndexes();
    await MeetingParticipant.syncIndexes();
    const meetings = [];
    for (let r = 0; r < Math.max(1, SCENARIO === "hot-room" ? 1 : ROOMS); r += 1) {
      const hostId = new mongoose.Types.ObjectId();
      const m = await Meeting.create({ title: `load-${r}`, hostId, status: "live" });
      meetings.push(m);
    }
    const users = [];
    for (let u = 0; u < Math.max(1, USERS); u += 1) {
      const userId = new mongoose.Types.ObjectId();
      users.push({ userId, token: signAuthToken(userId.toString()) });
    }
    // One admitted membership per (meeting, user) pair used below.
    const needPairs = new Map();
    const pick = (i) => {
      if (SCENARIO === "hot-room") return { m: meetings[0], u: users[i % users.length] };
      if (SCENARIO === "reconnect") {
        const u = users[i % users.length];
        return { m: meetings[i % meetings.length], u };
      }
      return { m: meetings[i % meetings.length], u: users[i % users.length] };
    };
    const total = SCENARIO === "reconnect" ? users.length * REPEATS : N;
    for (let i = 0; i < total; i += 1) {
      const { m, u } = pick(i);
      const key = `${m._id}:${u.userId}`;
      if (!needPairs.has(key)) needPairs.set(key, { m, u });
      plan.push({ meetingId: m._id.toString(), token: u.token });
    }
    for (const { m, u } of needPairs.values()) {
      await MeetingParticipant.updateOne(
        { meetingId: m._id, userId: u.userId },
        { $setOnInsert: { status: "admitted" } },
        { upsert: true }
      );
    }
    const origFindById = Meeting.findById.bind(Meeting);
    const origFindOne = MeetingParticipant.findOne.bind(MeetingParticipant);
    Meeting.findById = (...args) => {
      dbQueries += 1;
      return origFindById(...args);
    };
    MeetingParticipant.findOne = (...args) => {
      dbQueries += 1;
      return origFindOne(...args);
    };
    cleanup = async () => {
      await MeetingParticipant.deleteMany({
        meetingId: { $in: meetings.map((m) => m._id) },
      });
      await Meeting.deleteMany({ _id: { $in: meetings.map((m) => m._id) } });
      await mongoose.disconnect();
    };
  }

  joinRateLimit.resetForTests();
  metrics.reset();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const latencies = [];
  let ok = 0;
  const errors = {};
  const cpuStart = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  async function one(job) {
    const s = process.hrtime.bigint();
    let status = 0;
    try {
      const res = await fetch(`${baseUrl}/api/meetings/${job.meetingId}/join`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${job.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      status = res.status;
      await res.text();
    } catch (_unused) {
      status = -1;
    }
    latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
    if (status === 200) ok += 1;
    else errors[String(status)] = (errors[String(status)] || 0) + 1;
  }
  for (let i = 0; i < plan.length; i += CONCURRENCY) {
    await Promise.all(plan.slice(i, i + CONCURRENCY).map(one));
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const cpuDelta = process.cpuUsage(cpuStart);
  latencies.sort((a, b) => a - b);
  const snap = metrics.getSnapshot();

  console.log(
    JSON.stringify(
      {
        mode: MODE,
        scenario: SCENARIO,
        requests: plan.length,
        concurrency: CONCURRENCY,
        seconds: Math.round(secs * 100) / 100,
        requestsPerSec: Math.round((plan.length / secs) * 10) / 10,
        p50Ms: Math.round(percentile(latencies, 0.5) * 100) / 100,
        p95Ms: Math.round(percentile(latencies, 0.95) * 100) / 100,
        p99Ms: Math.round(percentile(latencies, 0.99) * 100) / 100,
        ok,
        errors,
        errorRate: Math.round(((plan.length - ok) / plan.length) * 10000) / 10000,
        dbQueries,
        dbQueriesPerRequest: Math.round((dbQueries / plan.length) * 100) / 100,
        cpuUserMs: Math.round(cpuDelta.user / 1000),
        cpuSystemMs: Math.round(cpuDelta.system / 1000),
        rssMB: snap.rssMB,
        heapUsedMB: snap.heapUsedMB,
      },
      null,
      2
    )
  );

  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await cleanup();
}

main().catch((err) => {
  console.error(JSON.stringify({ harness: "failed", message: err && err.message }));
  process.exit(1);
});
