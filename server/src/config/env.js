"use strict";

const dotenv = require("dotenv");

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
  };
}

function resetEnvCache() {
  cachedEnv = null;
}

module.exports = { loadEnv, getEnv, getSafeEnvSummary, resetEnvCache };
