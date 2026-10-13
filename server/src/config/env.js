"use strict";

const dotenv = require("dotenv");

const { CHAT_LIMITS } = require("../constants/chatLimits");

dotenv.config();

const VALID_NODE_ENVS = new Set(["development", "test", "production"]);

function parsePort(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return 5000;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseNodeEnv(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return "development";
  }
  if (!VALID_NODE_ENVS.has(raw)) {
    throw new Error("NODE_ENV must be one of development, test, production.");
  }
  return raw;
}

function parseClientUrl(raw, nodeEnv) {
  if (raw === undefined || raw === null || raw === "") {
    if (nodeEnv === "production") {
      throw new Error("CLIENT_URL is required in production.");
    }
    return undefined;
  }
  let url;
  try {
    url = new URL(raw);
  } catch (_unused) {
    throw new Error("CLIENT_URL must be a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CLIENT_URL must be a valid http(s) URL.");
  }
  return raw;
}

function parseMongoUri(raw) {
  if (raw === undefined || raw === null || raw === "") {
    throw new Error("MONGODB_URI is required to connect to the database.");
  }
  if (typeof raw !== "string" || raw.length < 8) {
    throw new Error("MONGODB_URI is invalid.");
  }
  return raw;
}

function parseOptionalString(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  return raw;
}

function parseLivekitTtl(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return 600;
  }
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new Error("LIVEKIT_TTL_SECONDS must be an integer between 60 and 3600.");
  }
  return ttl;
}

function parseBoundedInt(raw, { def, min, max, name }) {
  if (raw === undefined || raw === null || raw === "") {
    return def;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

// Centralized, validated environment access for boot code only.
// Call with an explicit source object in tests; defaults to process.env.
// Never logs or returns secret values; use getSafeEnvSummary() for logs.
function loadEnv(source) {
  const envSource = source || process.env;
  const nodeEnv = parseNodeEnv(envSource.NODE_ENV);
  return {
    nodeEnv,
    port: parsePort(envSource.PORT),
    clientUrl: parseClientUrl(envSource.CLIENT_URL, nodeEnv),
    mongoUri: parseMongoUri(envSource.MONGODB_URI),
    jwtSecret: parseOptionalString(envSource.JWT_SECRET),
    livekitUrl: parseOptionalString(envSource.LIVEKIT_URL),
    livekitApiKey: parseOptionalString(envSource.LIVEKIT_API_KEY),
    livekitApiSecret: parseOptionalString(envSource.LIVEKIT_API_SECRET),
    livekitTtlSeconds: parseLivekitTtl(envSource.LIVEKIT_TTL_SECONDS),
    joinRateLimitMax: parseBoundedInt(envSource.JOIN_RATE_LIMIT_MAX, {
      def: 30,
      min: 1,
      max: 1000,
      name: "JOIN_RATE_LIMIT_MAX",
    }),
    joinRateLimitWindowMs: parseBoundedInt(envSource.JOIN_RATE_LIMIT_WINDOW_MS, {
      def: 60000,
      min: 1000,
      max: 600000,
      name: "JOIN_RATE_LIMIT_WINDOW_MS",
    }),
    mongoMaxPoolSize: parseBoundedInt(envSource.MONGO_MAX_POOL_SIZE, {
      def: 10,
      min: 1,
      max: 50,
      name: "MONGO_MAX_POOL_SIZE",
    }),
    mongoServerSelectionTimeoutMs: parseBoundedInt(
      envSource.MONGO_SERVER_SELECTION_TIMEOUT_MS,
      {
        def: 5000,
        min: 500,
        max: 30000,
        name: "MONGO_SERVER_SELECTION_TIMEOUT_MS",
      }
    ),
    mongoSocketTimeoutMs: parseBoundedInt(envSource.MONGO_SOCKET_TIMEOUT_MS, {
      def: 20000,
      min: 1000,
      max: 120000,
      name: "MONGO_SOCKET_TIMEOUT_MS",
    }),
    chatPageDefault: parseBoundedInt(envSource.CHAT_PAGE_DEFAULT, {
      def: CHAT_LIMITS.PAGE_DEFAULT,
      min: 1,
      max: 100,
      name: "CHAT_PAGE_DEFAULT",
    }),
    chatPageMax: parseBoundedInt(envSource.CHAT_PAGE_MAX, {
      def: CHAT_LIMITS.PAGE_MAX,
      min: 1,
      max: 200,
      name: "CHAT_PAGE_MAX",
    }),
    chatMaxChars: parseBoundedInt(envSource.CHAT_MAX_CHARS, {
      def: CHAT_LIMITS.MESSAGE_MAX_CHARS,
      min: 1,
      max: 10000,
      name: "CHAT_MAX_CHARS",
    }),
    chatMaxBytes: parseBoundedInt(envSource.CHAT_MAX_BYTES, {
      def: CHAT_LIMITS.MESSAGE_MAX_BYTES,
      min: 100,
      max: 40000,
      name: "CHAT_MAX_BYTES",
    }),
    chatSendPerSec: parseBoundedInt(envSource.CHAT_SEND_PER_SEC, {
      def: CHAT_LIMITS.SEND_PER_SEC,
      min: 1,
      max: 100,
      name: "CHAT_SEND_PER_SEC",
    }),
    chatSendBurst: parseBoundedInt(envSource.CHAT_SEND_BURST, {
      def: CHAT_LIMITS.SEND_BURST,
      min: 1,
      max: 200,
      name: "CHAT_SEND_BURST",
    }),
    chatMaxRoomsPerSocket: parseBoundedInt(envSource.CHAT_MAX_ROOMS_PER_SOCKET, {
      def: CHAT_LIMITS.MAX_ROOMS_PER_SOCKET,
      min: 1,
      max: 100,
      name: "CHAT_MAX_ROOMS_PER_SOCKET",
    }),
    chatMaxSockets: parseBoundedInt(envSource.CHAT_MAX_SOCKETS, {
      def: CHAT_LIMITS.MAX_SOCKETS,
      min: 1,
      max: 20000,
      name: "CHAT_MAX_SOCKETS",
    }),
    socketPacketMaxBytes: parseBoundedInt(envSource.SOCKET_PACKET_MAX_BYTES, {
      def: CHAT_LIMITS.PACKET_MAX_BYTES,
      min: 1024,
      max: 1048576,
      name: "SOCKET_PACKET_MAX_BYTES",
    }),
  };
}

let cachedEnv = null;

function getEnv() {
  if (!cachedEnv) {
    cachedEnv = loadEnv(process.env);
  }
  return cachedEnv;
}

// Redacted summary safe for startup logs. Contains no secret values.
function getSafeEnvSummary(env) {
  const resolved = env || getEnv();
  return {
    nodeEnv: resolved.nodeEnv,
    port: resolved.port,
    clientUrlConfigured: Boolean(resolved.clientUrl),
    mongoConfigured: Boolean(resolved.mongoUri),
    jwtConfigured: Boolean(resolved.jwtSecret),
    livekitConfigured: Boolean(
      resolved.livekitUrl && resolved.livekitApiKey && resolved.livekitApiSecret
    ),
  };
}

function resetEnvCache() {
  cachedEnv = null;
}

module.exports = { loadEnv, getEnv, getSafeEnvSummary, resetEnvCache };
