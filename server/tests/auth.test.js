"use strict";

// Cookie-only auth tests: credentials travel exclusively in HttpOnly
// cookies. Authorization headers, handshake auth tokens and JSON bodies
// are NOT credential paths (rejected). Covers register/login/me/
// refresh/logout/logout-all/change-password + CSRF (including
// pre-login bootstrap) + origin + socket cookie handshake + CORS
// credential headers + SameSite topology validation. Real MongoDB
// (isolated test database). No session/token store may be used.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet_cookie_auth_test";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";
process.env.LIVEKIT_URL = "wss://livekit.test.example.com";
process.env.LIVEKIT_API_KEY = "test-livekit-key";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-do-not-use";
process.env.RECORDING_PROVIDER = "disabled";

const { resetEnvCache, loadEnv } = require("../src/config/env");
resetEnvCache();

const http = require("node:http");
const app = require("../src/app");
const User = require("../src/models/User");
const Meeting = require("../src/models/Meeting");
const MeetingParticipant = require("../src/models/MeetingParticipant");
const { attachMeetingSockets } = require("../src/sockets/meetingSockets");
const { resetForTests: resetAuthLimits } = require("../src/middleware/authRateLimit");

let server;
let sockets;
let baseUrl;

const JWT_SECRET = "test-jwt-secret-do-not-use-in-prod";

// Deterministic pre-login (anonymous) CSRF value: HMAC(secret,
// "csrf:anonymous"). Mirrors GET /api/auth/csrf without a roundtrip.
function anonCsrf() {
  return crypto
    .createHmac("sha256", JWT_SECRET)
    .update("csrf:anonymous")
    .digest("base64url");
}

function parseSetCookies(res) {
  const out = {};
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) {
      out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return { jar: out, raw };
}

function jarHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function api(path, { method = "GET", jar, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(jar ? { cookie: jarHeader(jar) } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_unused) {
    json = null;
  }
  return { res, json, cookies: parseSetCookies(res) };
}

function withCsrf(jar) {
  return { "x-csrf-token": jar.im_csrf };
}

function anonHeaders(extraJar) {
  const v = anonCsrf();
  return {
    cookie: `im_csrf=${v}${extraJar ? `; ${extraJar}` : ""}`,
    "x-csrf-token": v,
  };
}

// Hand-minted tokens for negative cases (legacy/wrong-type/tampered).
function handMint(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret || JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

const PW = "correct horse battery staple!";

async function register(email, password = PW, name = "Test User") {
  return api("/api/auth/register", {
    method: "POST",
    body: { name, email, password },
    headers: anonHeaders(),
  });
}

async function login(email, password = PW) {
  return api("/api/auth/login", {
    method: "POST",
    body: { email, password },
    headers: anonHeaders(),
  });
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe("cookie-only auth", () => {
  before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await mongoose.connection.db.dropDatabase();
    await User.syncIndexes();
    server = http.createServer(app);
    sockets = attachMeetingSockets(server);
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (sockets) {
      await sockets.close();
    }
    if (server && server.listening) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    resetEnvCache();
    process.env.JWT_SECRET = JWT_SECRET;
    delete process.env.COOKIE_SAMESITE;
    resetAuthLimits();
    await User.deleteMany({});
    await Meeting.deleteMany({});
    await MeetingParticipant.deleteMany({});
  });

  it("registers one user; DTO has no secrets; duplicate → 409", async () => {
    const r = await register("alice@example.com");
    assert.equal(r.res.status, 201);
    assert.equal(r.json.user.email, "alice@example.com");
    assert.equal(r.json.user.role, "user");
    assert.ok(!("passwordHash" in r.json.user));
    const stored = await User.findOne({ email: "alice@example.com" }).lean();
    assert.match(stored.passwordHash, /^\$argon2id\$/);

    const dup = await register("alice@example.com");
    assert.equal(dup.res.status, 409);
    assert.equal(dup.json.error.code, "DUPLICATE_EMAIL");
  });

  it("register and login require pre-login CSRF + origin", async () => {
    const noCsrf = await api("/api/auth/register", {
      method: "POST",
      body: { name: "X", email: "x@example.com", password: PW },
    });
    assert.equal(noCsrf.res.status, 403);
    assert.equal(noCsrf.json.error.code, "CSRF_REQUIRED");
    const badOrigin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", ...anonHeaders() },
      body: JSON.stringify({ email: "x@example.com", password: PW }),
    });
    assert.equal(badOrigin.status, 403);
  });

  it("concurrent duplicate registration creates one account", async () => {
    const [a, b] = await Promise.all([
      register("race@example.com"),
      register("race@example.com"),
    ]);
    const statuses = [a.res.status, b.res.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(await User.countDocuments({ email: "race@example.com" }), 1);
  });

  it("rejects field injection and normalizes email", async () => {
    const evil = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Evil", email: "evil@example.com", password: PW, role: "admin", status: "active" },
      headers: anonHeaders(),
    });
    assert.equal(evil.res.status, 400);

    const r = await register("  MixedCase@Example.COM ");
    assert.equal(r.res.status, 201);
    const l = await login("MIXEDCASE@example.com");
    assert.equal(l.res.status, 200);
    const stored = await User.findOne({ email: "mixedcase@example.com" }).lean();
    assert.equal(stored.role, "user");
  });

  it("enforces new-password policy but allows spaces", async () => {
    assert.equal((await register("s@example.com", "short1!")).res.status, 400);
    assert.equal((await register("c@example.com", "password123!")).res.status, 400);
    assert.equal((await register("sp@example.com", "this password has spaces 123!")).res.status, 201);
  });

  it("login sets HttpOnly cookies with safe flags; JSON carries no tokens", async () => {
    await register("bob@example.com");
    const l = await login("bob@example.com");
    assert.equal(l.res.status, 200);
    assert.ok(l.cookies.jar.im_at, "access cookie set");
    assert.ok(l.cookies.jar.im_rt, "refresh cookie set");
    assert.ok(l.cookies.jar.im_csrf, "csrf cookie set");
    const raw = l.cookies.raw.join(";");
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    assert.ok(!/Domain=/i.test(raw), "host-only: no Domain attribute");
    assert.ok(!("accessToken" in l.json), "no access token in JSON");
    assert.ok(!("refreshToken" in l.json), "no refresh token in JSON");
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(l.json)), "no JWT-shaped value in JSON");
    assert.ok(l.json.csrfToken, "readable CSRF value for memory use");
    // Refresh cookie is scoped to the auth path.
    const rt = l.cookies.raw.find((c) => c.startsWith("im_rt="));
    assert.match(rt, /Path=\/api\/auth/i);

    for (const [email, pw] of [["bob@example.com", "wrong password here!!"], ["nobody@example.com", PW]]) {
      const f = await login(email, pw);
      assert.equal(f.res.status, 401);
      assert.equal(f.json.error.code, "INVALID_CREDENTIALS");
      assert.equal(f.json.error.message, "Invalid email or password.");
    }
    await User.updateOne({ email: "bob@example.com" }, { $set: { status: "disabled" } });
    assert.equal((await login("bob@example.com")).res.status, 401);
  });

  it("Authorization header is not a credential path", async () => {
    await register("h@example.com");
    const l = await login("h@example.com");
    const token = l.cookies.jar.im_at;
    // Valid JWT in Authorization is ignored → 401 on every consumer.
    assert.equal((await api("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })).res.status, 401);
    const joinId = new mongoose.Types.ObjectId().toString();
    const j = await fetch(`${baseUrl}/api/meetings/${joinId}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.ok([400, 401].includes(j.status), "no Bearer credential path");
    // ...while the same token as a cookie authenticates.
    const me = await api("/api/auth/me", { jar: l.cookies.jar });
    assert.equal(me.res.status, 200);
  });

  it("/me works via cookie; DTO is whitelisted, not the JWT payload", async () => {
    await register("me@example.com");
    const l = await login("me@example.com");
    const me = await api("/api/auth/me", { jar: l.cookies.jar });
    assert.equal(me.res.status, 200);
    assert.deepEqual(Object.keys(me.json.user).sort(), ["email", "id", "name", "role"]);
    assert.equal((await api("/api/auth/me")).res.status, 401);
  });

  it("rejects legacy, wrong-purpose, tampered and expired tokens", async () => {
    await register("leg@example.com");
    const user = await User.findOne({ email: "leg@example.com" }).lean();
    const now = Math.floor(Date.now() / 1000);
    const base = { sub: String(user._id), iss: "intellmeet", aud: "intellmeet-app", ver: 0, jti: "t", iat: now, exp: now + 600 };
    const cases = [
      ["legacy sub-only", handMint({ sub: String(user._id), iat: now, exp: now + 600 })],
      ["legacy sid-style", handMint({ sub: String(user._id), sid: "abc", iat: now, exp: now + 600 })],
      ["refresh-as-access", handMint({ ...base, purpose: "refresh" })],
      ["wrong audience", handMint({ ...base, purpose: "access", aud: "other" })],
      ["wrong issuer", handMint({ ...base, purpose: "access", iss: "other" })],
      ["stale version", handMint({ ...base, purpose: "access", ver: 99 })],
      ["expired", handMint({ ...base, purpose: "access", exp: now - 10 })],
      ["forged secret", handMint({ ...base, purpose: "access" }, "wrong-secret")],
      ["livekit-shaped", handMint({ iss: "livekit-key", sub: String(user._id), exp: now + 600, grants: { roomJoin: true } })],
    ];
    for (const [name, token] of cases) {
      const r = await api("/api/auth/me", { headers: { cookie: `im_at=${token}` } });
      assert.equal(r.res.status, 401, name);
    }
  });

  it("refresh mints bounded access without extending the refresh deadline; bodies are not credentials", async () => {
    await register("r@example.com");
    const l = await login("r@example.com");
    const beforeRefresh = decodePayload(l.cookies.jar.im_rt);
    const r1 = await api("/api/auth/refresh", { method: "POST", jar: l.cookies.jar, body: {}, headers: withCsrf(l.cookies.jar) });
    assert.equal(r1.res.status, 200);
    assert.ok(!("accessToken" in r1.json), "no tokens in refresh JSON");
    const newAccess = decodePayload(r1.cookies.jar.im_at);
    assert.equal(newAccess.purpose, "access");
    assert.equal(newAccess.lb, beforeRefresh.lb, "absolute deadline preserved");
    assert.ok(newAccess.exp <= beforeRefresh.lb, "access bounded by deadline");
    assert.ok(
      !r1.cookies.raw.some((c) => c.startsWith("im_rt=")),
      "refresh cookie not reissued"
    );
    // A valid refresh JWT in a JSON body is ignored → 401, not honored.
    const viaBody = await api("/api/auth/refresh", {
      method: "POST",
      body: { refreshToken: l.cookies.jar.im_rt },
      headers: anonHeaders(),
    });
    assert.equal(viaBody.res.status, 401);
    assert.equal(viaBody.json.error.code, "INVALID_REFRESH");
  });

  it("normal logout clears cookies but copied JWTs stay valid until expiry/version (documented limit)", async () => {
    await register("copy@example.com");
    const l = await login("copy@example.com");
    const copiedAccess = l.cookies.jar.im_at;
    const copiedRefresh = l.cookies.jar.im_rt;
    const out = await api("/api/auth/logout", { method: "POST", jar: l.cookies.jar, body: {}, headers: withCsrf(l.cookies.jar) });
    assert.equal(out.res.status, 200);
    const cleared = out.cookies.raw.join(";");
    assert.match(cleared, /im_at=;/);
    assert.match(cleared, /im_rt=;/);
    assert.equal((await api("/api/auth/me", { headers: { cookie: `im_at=${copiedAccess}` } })).res.status, 200);
    const copiedJti = decodePayload(copiedRefresh).jti;
    const copiedCsrf = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`csrf:${copiedJti}`)
      .digest("base64url");
    const replay = await api("/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `im_rt=${copiedRefresh}; im_csrf=${copiedCsrf}`, "content-type": "application/json", "x-csrf-token": copiedCsrf },
      body: {},
    });
    assert.equal(replay.res.status, 200, "copied refresh still mints (stated limit)");
    assert.equal((await api("/api/auth/logout", { method: "POST", jar: l.cookies.jar, body: {}, headers: withCsrf(l.cookies.jar) })).res.status, 200);
    assert.equal((await api("/api/auth/logout", { method: "POST", body: {} })).res.status, 200);
  });

  it("change-password invalidates old-version tokens; requires fresh login", async () => {
    await register("pw@example.com");
    const l = await login("pw@example.com");
    const oldAccess = l.cookies.jar.im_at;
    assert.equal((await api("/api/auth/change-password", {
      method: "PATCH", jar: l.cookies.jar, body: { currentPassword: "wrong current password!", newPassword: "a brand new password 123!" }, headers: withCsrf(l.cookies.jar),
    })).res.status, 401);
    const ok = await api("/api/auth/change-password", {
      method: "PATCH", jar: l.cookies.jar, body: { currentPassword: PW, newPassword: "a brand new password 123!" }, headers: withCsrf(l.cookies.jar),
    });
    assert.equal(ok.res.status, 200);
    assert.equal(ok.json.requireRelogin, true);
    assert.equal((await api("/api/auth/me", { headers: { cookie: `im_at=${oldAccess}` } })).res.status, 401);
    assert.equal((await login("pw@example.com", PW)).res.status, 401);
    assert.equal((await login("pw@example.com", "a brand new password 123!")).res.status, 200);
  });

  it("concurrent password changes: one wins via conditional update", async () => {
    await register("race2@example.com");
    const l = await login("race2@example.com");
    const csrf = withCsrf(l.cookies.jar);
    const [a, b] = await Promise.all([
      api("/api/auth/change-password", { method: "PATCH", jar: l.cookies.jar, body: { currentPassword: PW, newPassword: "first new password 123!" }, headers: csrf }),
      api("/api/auth/change-password", { method: "PATCH", jar: l.cookies.jar, body: { currentPassword: PW, newPassword: "second new password 12!" }, headers: csrf }),
    ]);
    const codes = [a.res.status, b.res.status].sort();
    assert.deepEqual(codes, [200, 409]);
    const winner = a.res.status === 200 ? "first new password 123!" : "second new password 12!";
    assert.equal((await login("race2@example.com", winner)).res.status, 200);
  });

  it("logout-all bumps version: every device token dies", async () => {
    await register("all@example.com");
    const a = await login("all@example.com");
    const b = await login("all@example.com");
    const out = await api("/api/auth/logout-all", { method: "POST", jar: a.cookies.jar, body: {}, headers: withCsrf(a.cookies.jar) });
    assert.equal(out.res.status, 200);
    for (const jar of [a.cookies.jar, b.cookies.jar]) {
      assert.equal((await api("/api/auth/me", { jar })).res.status, 401);
    }
    const user = await User.findOne({ email: "all@example.com" }).lean();
    assert.equal(user.authVersion, 1);
  });

  it("cookie-only refresh needs CSRF", async () => {
    await register("csrf2@example.com");
    const l = await login("csrf2@example.com");
    const noCsrf = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: jarHeader(l.cookies.jar), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(noCsrf.status, 403);
  });

  it("socket handshake is cookie-only; version invalidation evicts", async () => {
    const { io: clientIo } = require("socket.io-client");
    await register("sock1@example.com");
    await register("sock2@example.com");
    const a = await login("sock1@example.com");
    const b = await login("sock2@example.com");
    const mk = (jar) =>
      new Promise((res, rej) => {
        const s = clientIo(baseUrl, {
          transports: ["websocket"],
          reconnection: false,
          extraHeaders: { cookie: jarHeader(jar) },
        });
        s.once("connect", () => res(s));
        s.once("connect_error", (e) => {
          try {
            s.close();
          } catch (_unused) {
            // Close failures are terminal anyway.
          }
          rej(e);
        });
      });
    const sockA = await mk(a.cookies.jar);
    const sockB = await mk(b.cookies.jar);
    // A VALID access token via handshake auth is rejected (not a path).
    await assert.rejects(
      new Promise((res, rej) => {
        const s = clientIo(baseUrl, { auth: { token: a.cookies.jar.im_at }, transports: ["websocket"], reconnection: false });
        s.once("connect", () => res(s));
        s.once("connect_error", (e) => {
          try {
            s.close();
          } catch (_unused) {
            // Close failures are terminal anyway.
          }
          rej(e);
        });
      })
    );
    const revoked = new Promise((res) => sockA.on("auth:revoked", res));
    const disconnected = new Promise((res) => sockA.on("disconnect", res));
    const cp = await api("/api/auth/change-password", {
      method: "PATCH", jar: a.cookies.jar,
      body: { currentPassword: PW, newPassword: "rotated password here!" },
      headers: withCsrf(a.cookies.jar),
    });
    assert.equal(cp.res.status, 200);
    await revoked;
    await disconnected;
    assert.equal(sockB.connected, true);
    await assert.rejects(mk(a.cookies.jar));
    const sockB2 = await mk(b.cookies.jar);
    assert.equal(sockB2.connected, true);
    sockB.disconnect();
    sockB2.disconnect();
  });

  it("socket handshake rejects legacy and LiveKit-shaped tokens", async () => {
    const { io: clientIo } = require("socket.io-client");
    await register("sockx@example.com");
    const user = await User.findOne({ email: "sockx@example.com" }).lean();
    const now = Math.floor(Date.now() / 1000);
    const legacy = handMint({ sub: String(user._id), iat: now, exp: now + 600 });
    const livekit = handMint({ iss: "livekit-key", sub: String(user._id), exp: now + 600, grants: { roomJoin: true } });
    for (const bad of [legacy, livekit]) {
      await assert.rejects(
        new Promise((res, rej) => {
          const s = clientIo(baseUrl, { extraHeaders: { cookie: `im_at=${bad}` }, transports: ["websocket"], reconnection: false });
          s.once("connect", () => res(s));
          s.once("connect_error", (e) => {
            try {
              s.close();
            } catch (_unused) {
              // Close failures are terminal anyway.
            }
            rej(e);
          });
        })
      );
    }
  });

  it("Socket.IO and HTTP CORS allow the exact frontend origin with credentials", async () => {
    // Engine.IO polling handshake exposes the Socket.IO CORS config a
    // browser would rely on (withCredentials needs ACAC:true).
    const polling = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: process.env.CLIENT_URL },
    });
    assert.equal(polling.headers.get("access-control-allow-origin"), process.env.CLIENT_URL);
    assert.equal(polling.headers.get("access-control-allow-credentials"), "true");
    // Unlisted origins get no usable credentialed access: the ACAO
    // response is the allowlisted origin, never the evil one, so a
    // browser blocks the credentialed read (origin mismatch).
    const evil = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: "https://evil.example" },
    });
    assert.notEqual(evil.headers.get("access-control-allow-origin"), "https://evil.example");
  });

  it("cookie topology is explicit: lax default, production-only cross-site mode", async () => {
    const base = {
      MONGODB_URI: "mongodb://127.0.0.1:27017/x",
      JWT_SECRET: "s",
      NODE_ENV: "test",
      CLIENT_URL: "http://localhost:5173",
    };
    assert.equal(loadEnv(base).cookieSameSite, "lax");
    assert.throws(() => loadEnv({ ...base, COOKIE_SAMESITE: "bogus" }), /COOKIE_SAMESITE/);
    assert.throws(
      () => loadEnv({ ...base, COOKIE_SAMESITE: "none" }),
      /requires NODE_ENV=production/
    );
    const prod = loadEnv({
      ...base,
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      COOKIE_SAMESITE: "none",
    });
    assert.equal(prod.cookieSameSite, "none");
  });

  it("uses no server-side session/token persistence", async () => {
    assert.ok(!mongoose.models.Session, "no Session model registered");
    await register("nosess@example.com");
    await login("nosess@example.com");
    const names = await mongoose.connection.db.listCollections().toArray().then((c) => c.map((x) => x.name));
    assert.ok(!names.includes("sessions"), "no sessions collection created");
    assert.ok(!names.includes("refreshtokens"), "no refresh collection created");
  });

  it("meeting admission contract unchanged with cookie tokens", async () => {
    await register("host@example.com");
    const l = await login("host@example.com");
    const user = await User.findOne({ email: "host@example.com" }).lean();
    const meetingId = new mongoose.Types.ObjectId();
    const origFindById = Meeting.findById;
    const origFindOne = MeetingParticipant.findOne;
    Meeting.findById = () => ({ lean: async () => ({ _id: meetingId, hostId: user._id, status: "live" }) });
    MeetingParticipant.findOne = () => ({ lean: async () => null });
    try {
      const res = await fetch(`${baseUrl}/api/meetings/${meetingId}/join`, {
        method: "POST",
        headers: {
          cookie: `im_at=${l.cookies.jar.im_at}; im_csrf=${l.cookies.jar.im_csrf}`,
          "content-type": "application/json",
          "x-csrf-token": l.cookies.jar.im_csrf,
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.permissions.isHost, true);
    } finally {
      Meeting.findById = origFindById;
      MeetingParticipant.findOne = origFindOne;
    }
  });
});
