"use strict";

const { AccessToken, TokenVerifier } = require("livekit-server-sdk");

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const logger = require("../config/logger");

function configuredCredentials() {
  const { livekitUrl, livekitApiKey, livekitApiSecret } = getEnv();
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Meeting join is not configured.",
      "LIVEKIT_MISCONFIGURED"
    );
  }
  return { livekitUrl, livekitApiKey, livekitApiSecret };
}

function validateClaims({ claims, identity, roomName, apiKey }) {
  if (
    !claims ||
    claims.iss !== apiKey ||
    claims.sub !== identity ||
    !claims.video ||
    claims.video.roomJoin !== true ||
    claims.video.room !== roomName
  ) {
    throw new Error("LiveKit issued token claims were invalid.");
  }
}

async function mintJoinToken({ identity, roomName, displayName, ttlSeconds, canPublish, canPublishData }) {
  const { livekitUrl, livekitApiKey, livekitApiSecret } = configuredCredentials();
  const ttl =
    Number.isInteger(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds
      : getEnv().livekitTtlSeconds;

  try {
    const tokenBuilder = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity,
      ...(typeof displayName === "string" && displayName.trim()
        ? { name: displayName.trim().slice(0, 100) }
        : {}),
      ttl,
    });
    tokenBuilder.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: canPublish !== false,
      canSubscribe: true,
      canPublishData: canPublishData !== false,
      roomAdmin: false,
      recorder: false,
    });
    const token = await tokenBuilder.toJwt();
    if (typeof token !== "string" || token.split(".").length !== 3) {
      throw new Error("LiveKit issued token was malformed.");
    }
    const claims = await new TokenVerifier(livekitApiKey, livekitApiSecret).verify(token);
    validateClaims({ claims, identity, roomName, apiKey: livekitApiKey });
    return { token, livekitUrl, roomName, ttlSeconds: ttl };
  } catch (error) {
    logger.error("livekit_token_sign_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Could not issue a join token.",
      "TOKEN_SIGNING_FAILED"
    );
  }
}

module.exports = { mintJoinToken, validateClaims };
