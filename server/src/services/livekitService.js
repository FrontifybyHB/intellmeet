"use strict";

const crypto = require("node:crypto");

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const logger = require("../config/logger");

function base64UrlEncodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Minimal LiveKit-style room token signer (HS256 JWT). Keeps the
// LiveKit API secret server-side; only the short-lived token is
// returned to the client. Never logs tokens or secrets.
// canPublish/canPublishData default to true; the join path may pass
// false for late joins during active capture when the joiner has not
// approved the current recording notice (server-side admission gate —
// never a client mute/UI control). roomAdmin/recorder stay false for
// ordinary participant tokens: Egress requires server-side recording
// permission that is never granted to participants.
function mintJoinToken({ identity, roomName, ttlSeconds, issuedAtSeconds, canPublish, canPublishData }) {
  const { livekitUrl, livekitApiKey, livekitApiSecret } = getEnv();
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Meeting join is not configured.",
      "LIVEKIT_MISCONFIGURED"
    );
  }
  const ttl =
    Number.isInteger(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds
      : getEnv().livekitTtlSeconds;
  const now = Number.isInteger(issuedAtSeconds)
    ? issuedAtSeconds
    : Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: livekitApiKey,
    sub: identity,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + ttl,
    grants: {
      roomJoin: true,
      room: roomName,
      canPublish: canPublish !== false,
      canSubscribe: true,
      canPublishData: canPublishData !== false,
      roomAdmin: false,
      recorder: false,
    },
  };
  let token;
  try {
    const encodedHeader = base64UrlEncodeJson(header);
    const encodedPayload = base64UrlEncodeJson(payload);
    const signature = crypto
      .createHmac("sha256", livekitApiSecret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest("base64url");
    token = `${encodedHeader}.${encodedPayload}.${signature}`;
  } catch (_unused) {
    logger.error("livekit_token_sign_failed", {});
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Could not issue a join token.",
      "TOKEN_SIGNING_FAILED"
    );
  }
  return { token, livekitUrl, roomName, ttlSeconds: ttl };
}

module.exports = { mintJoinToken };
