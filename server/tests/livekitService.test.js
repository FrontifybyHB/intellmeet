"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { AccessToken, TokenVerifier } = require("livekit-server-sdk");

const { validateClaims } = require("../src/services/livekitService");

const API_KEY = "test-livekit-key";
const API_SECRET = "test-livekit-secret";
const ROOM = "meeting_test";

async function token({ secret = API_SECRET, ttl = 600, grant = {} } = {}) {
  const builder = new AccessToken(API_KEY, secret, { identity: "user-1", ttl });
  builder.addGrant({ roomJoin: true, room: ROOM, canSubscribe: true, ...grant });
  return builder.toJwt();
}

function signedClaims(claims, secret = API_SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("LiveKit participant tokens", () => {
  it("verifies the SDK token signature and required join claims", async () => {
    const signed = await token();
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(signed);
    validateClaims({ claims, identity: "user-1", roomName: ROOM, apiKey: API_KEY });
    assert.equal(signed.split(".").length, 3);
    assert.equal(claims.video.roomJoin, true);
    assert.equal(claims.video.room, ROOM);
  });

  it("rejects a token signed with the wrong key", async () => {
    const signed = await token({ secret: "wrong-secret" });
    await assert.rejects(
      () => new TokenVerifier(API_KEY, API_SECRET).verify(signed),
      /signature|JWSSignatureVerificationFailed/i,
    );
  });

  it("rejects expired and not-yet-valid tokens", async () => {
    const expired = await token({ ttl: -60 });
    await assert.rejects(
      () => new TokenVerifier(API_KEY, API_SECRET).verify(expired),
      /exp|expired/i,
    );
    const now = Math.floor(Date.now() / 1000);
    const future = signedClaims({ iss: API_KEY, sub: "user-1", iat: now, nbf: now + 3600, exp: now + 7200, video: { roomJoin: true, room: ROOM } });
    await assert.rejects(
      () => new TokenVerifier(API_KEY, API_SECRET).verify(future),
      /not active|nbf/i,
    );
  });

  it("rejects missing or wrong room join claims", async () => {
    const signed = await token({ grant: { roomJoin: false } });
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(signed);
    assert.throws(
      () => validateClaims({ claims, identity: "user-1", roomName: ROOM, apiKey: API_KEY }),
      /claims were invalid/,
    );
    assert.throws(
      () => validateClaims({ claims: { ...claims, video: { ...claims.video, room: "other" } }, identity: "user-1", roomName: ROOM, apiKey: API_KEY }),
      /claims were invalid/,
    );
  });

  it("rejects the legacy grants claim shape that LiveKit Cloud does not consume", async () => {
    const now = Math.floor(Date.now() / 1000);
    const legacy = signedClaims({
      iss: API_KEY,
      sub: "user-1",
      iat: now,
      nbf: now,
      exp: now + 600,
      grants: { roomJoin: true, room: ROOM },
    });
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(legacy);
    assert.throws(
      () => validateClaims({ claims, identity: "user-1", roomName: ROOM, apiKey: API_KEY }),
      /claims were invalid/,
    );
  });

  it("rejects malformed and unawaited token values", async () => {
    await assert.rejects(
      () => new TokenVerifier(API_KEY, API_SECRET).verify("[object Promise]"),
      /Compact JWS|Invalid Compact JWS|JWT/i,
    );
    await assert.rejects(
      () => new TokenVerifier(API_KEY, API_SECRET).verify("not.a.valid.token"),
      /JWT|JWS/i,
    );
  });
});
