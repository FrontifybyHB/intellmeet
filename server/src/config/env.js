"use strict";

const dotenv = require("dotenv");

const { CHAT_LIMITS } = require("../constants/chatLimits");
const { RECORDING_LIMITS } = require("../constants/recordingLimits");
const { TRANSCRIPTION_LIMITS } = require("../constants/transcriptionLimits");
const { INTELLIGENCE_LIMITS } = require("../constants/intelligenceLimits");

dotenv.config();

const VALID_NODE_ENVS = new Set(["development", "test", "production"]);

function parsePort(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return 3000;
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
  // Browser Origin values are always scheme + host + optional port.  Keeping
  // a deployment value such as "https://app.example.com/" verbatim makes a
  // legitimate browser request fail the strict CORS comparison in production.
  // Canonicalize it once so the allowlist and the browser use the same value.
  return url.origin;
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

function parseRecordingStorage(envSource) {
  const b2 = [
    envSource.B2_ACCESS_KEY_ID,
    envSource.B2_SECRET_ACCESS_KEY,
    envSource.B2_BUCKET_NAME,
    envSource.B2_REGION,
    envSource.B2_ENDPOINT,
  ].map(parseOptionalString);
  const legacy = [
    envSource.RECORDING_STORAGE_ACCESS_KEY,
    envSource.RECORDING_STORAGE_SECRET,
    envSource.RECORDING_OUTPUT_BUCKET,
    envSource.RECORDING_STORAGE_REGION,
    envSource.RECORDING_STORAGE_ENDPOINT,
  ].map(parseOptionalString);
  const b2Count = b2.filter(Boolean).length;
  const legacyCount = legacy.filter(Boolean).length;
  if (b2Count > 0 && b2Count < b2.length) {
    throw new Error("B2 recording storage configuration must be complete.");
  }
  if (b2Count > 0 && legacyCount > 0) {
    throw new Error("B2 and legacy recording storage configuration cannot be mixed.");
  }
  if (b2Count === 0 && legacyCount > 0 && legacyCount < legacy.length) {
    throw new Error("Legacy recording storage configuration must be complete.");
  }
  const values = b2Count === b2.length ? b2 : legacy;
  const [accessKey, secret, bucket, region, endpoint] = values;
  if (endpoint) {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch (_unused) {
      throw new Error("B2_ENDPOINT must be a valid HTTPS endpoint.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/i.test(parsed.hostname)
    ) {
      throw new Error("B2_ENDPOINT must be a trusted regional HTTPS B2 S3 endpoint.");
    }
    const endpointRegion = parsed.hostname.split(".")[1];
    if (region && region !== endpointRegion) {
      throw new Error("B2_REGION must match the regional B2 endpoint.");
    }
  }
  return {
    accessKey,
    secret,
    bucket,
    region,
    endpoint,
    configured: Boolean(accessKey && secret && bucket && region && endpoint),
  };
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

function parseRecordingProvider(raw) {
  if (raw === undefined || raw === null || raw === "") {
    // Fail closed: without an explicit provider choice, recording
    // control-plane calls return 503 INTEGRATION_BLOCKER. "mock" is for
    // tests; "live" requires credentials + Egress-compatible storage.
    return "disabled";
  }
  if (raw === "disabled" || raw === "mock" || raw === "live") {
    return raw;
  }
  throw new Error("RECORDING_PROVIDER must be one of disabled, mock, live.");
}

function parseNoticeVersion(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return RECORDING_LIMITS.NOTICE_VERSION_DEFAULT;
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > RECORDING_LIMITS.NOTICE_VERSION_MAX
  ) {
    throw new Error(
      `RECORDING_NOTICE_VERSION must be 1-${RECORDING_LIMITS.NOTICE_VERSION_MAX} chars.`
    );
  }
  return raw;
}

function parseRecordingOutputFormat(raw) {
  const value = String(raw || RECORDING_LIMITS.OUTPUT_FORMAT_DEFAULT).toLowerCase();
  if (!new Set(["mp4", "ogg", "mp3"]).has(value)) {
    throw new Error("RECORDING_OUTPUT_FORMAT must be mp4, ogg or mp3.");
  }
  return value;
}

// Cookie topology mode. Default "lax" is correct for same-site
// deployments (frontend and API share a site; ports may differ).
// "none" is an explicit, production-only cross-site mode
// (SameSite=None + forced Secure); any other value, or "none"
// outside production, fails startup. Cross-site deployments remain
// subject to browser third-party-cookie blocking — CORS does not
// bypass that (documented deployment limit, not a code fix).
function parseCookieSameSite(raw, nodeEnv) {
  if (raw === undefined || raw === null || raw === "") {
    return "lax";
  }
  const v = String(raw).trim().toLowerCase();
  if (v !== "lax" && v !== "none") {
    throw new Error("COOKIE_SAMESITE must be one of lax, none.");
  }
  if (v === "none" && nodeEnv !== "production") {
    throw new Error("COOKIE_SAMESITE=none requires NODE_ENV=production (Secure).");
  }
  return v;
}

function parseTranscriptionProvider(raw) {
  if (raw === undefined || raw === null || raw === "") {
    // Fail closed: without an explicit provider choice, transcription
    // enqueue/processing returns 503 INTEGRATION_BLOCKER. "mock" is for
    // tests (deterministic, labeled); "live" requires GEMINI_API_KEY.
    return "disabled";
  }
  if (raw === "disabled" || raw === "mock" || raw === "live") {
    return raw;
  }
  throw new Error("TRANSCRIPTION_PROVIDER must be one of disabled, mock, live.");
}

function parseIntelligenceProvider(raw) {
  if (raw === undefined || raw === null || raw === "") {
    // Fail closed: without an explicit provider choice, intelligence
    // enqueue/processing returns 503 INTEGRATION_BLOCKER. "mock" is for
    // tests (deterministic, labeled); "live" requires GEMINI_API_KEY.
    return "disabled";
  }
  if (raw === "disabled" || raw === "mock" || raw === "live") {
    return raw;
  }
  throw new Error("INTELLIGENCE_PROVIDER must be one of disabled, mock, live.");
}

function parseGeminiModel(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return TRANSCRIPTION_LIMITS.GEMINI_MODEL_DEFAULT;
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > TRANSCRIPTION_LIMITS.GEMINI_MODEL_MAX ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)
  ) {
    throw new Error("GEMINI_MODEL must be a safe model identifier.");
  }
  return raw;
}

// Centralized, validated environment access for boot code only.
// Call with an explicit source object in tests; defaults to process.env.
// Never logs or returns secret values; use getSafeEnvSummary() for logs.
function loadEnv(source) {
  const envSource = source || process.env;
  const nodeEnv = parseNodeEnv(envSource.NODE_ENV);
  const clientUrl = parseClientUrl(envSource.CLIENT_URL, nodeEnv);
  const storage = parseRecordingStorage(envSource);
  const jwtSecret = parseOptionalString(envSource.JWT_SECRET);
  if (nodeEnv === "production" && !jwtSecret) {
    throw new Error("JWT_SECRET is required in production.");
  }
  return {
    nodeEnv,
    port: parsePort(envSource.PORT),
    clientUrl,
    cookieSameSite: parseCookieSameSite(envSource.COOKIE_SAMESITE, nodeEnv),
    mongoUri: parseMongoUri(envSource.MONGODB_URI),
    jwtSecret,
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
    recordingProvider: parseRecordingProvider(envSource.RECORDING_PROVIDER),
    recordingNoticeVersion: parseNoticeVersion(envSource.RECORDING_NOTICE_VERSION),
    recordingWebhookSecret: parseOptionalString(
      envSource.LIVEKIT_WEBHOOK_SECRET
    ),
    recordingOutputBucket: storage.bucket,
    recordingStorageAccessKey: storage.accessKey,
    recordingStorageSecret: storage.secret,
    recordingStorageRegion: storage.region,
    recordingStorageEndpoint: storage.endpoint,
    recordingStorageConfigured: storage.configured,
    recordingStorageForcePathStyle: envSource.RECORDING_STORAGE_FORCE_PATH_STYLE === "true",
    recordingOutputFormat: parseRecordingOutputFormat(envSource.RECORDING_OUTPUT_FORMAT),
    recordingKeyPrefix: parseOptionalString(envSource.RECORDING_KEY_PREFIX) ||
      RECORDING_LIMITS.STORAGE_KEY_PREFIX_DEFAULT,
    recordingStorageBaseUrl: parseOptionalString(
      envSource.RECORDING_STORAGE_BASE_URL
    ),
    recordingProviderTimeoutMs: parseBoundedInt(
      envSource.RECORDING_PROVIDER_TIMEOUT_MS,
      {
        def: RECORDING_LIMITS.PROVIDER_TIMEOUT_MS_DEFAULT,
        min: RECORDING_LIMITS.PROVIDER_TIMEOUT_MS_MIN,
        max: RECORDING_LIMITS.PROVIDER_TIMEOUT_MS_MAX,
        name: "RECORDING_PROVIDER_TIMEOUT_MS",
      }
    ),
    recordingMaxActiveGlobal: parseBoundedInt(
      envSource.RECORDING_MAX_ACTIVE_GLOBAL,
      {
        def: RECORDING_LIMITS.MAX_ACTIVE_GLOBAL_DEFAULT,
        min: RECORDING_LIMITS.MAX_ACTIVE_GLOBAL_MIN,
        max: RECORDING_LIMITS.MAX_ACTIVE_GLOBAL_MAX,
        name: "RECORDING_MAX_ACTIVE_GLOBAL",
      }
    ),
    recordingRecoveryBatch: parseBoundedInt(envSource.RECORDING_RECOVERY_BATCH, {
      def: RECORDING_LIMITS.RECOVERY_BATCH_DEFAULT,
      min: RECORDING_LIMITS.RECOVERY_BATCH_MIN,
      max: RECORDING_LIMITS.RECOVERY_BATCH_MAX,
      name: "RECORDING_RECOVERY_BATCH",
    }),
    recordingRecoveryLeaseMs: parseBoundedInt(
      envSource.RECORDING_RECOVERY_LEASE_MS,
      {
        def: RECORDING_LIMITS.RECOVERY_LEASE_MS_DEFAULT,
        min: RECORDING_LIMITS.RECOVERY_LEASE_MS_MIN,
        max: RECORDING_LIMITS.RECOVERY_LEASE_MS_MAX,
        name: "RECORDING_RECOVERY_LEASE_MS",
      }
    ),
    recordingRecoveryMaxAttempts: parseBoundedInt(
      envSource.RECORDING_RECOVERY_MAX_ATTEMPTS,
      {
        def: RECORDING_LIMITS.RECOVERY_MAX_ATTEMPTS_DEFAULT,
        min: RECORDING_LIMITS.RECOVERY_MAX_ATTEMPTS_MIN,
        max: RECORDING_LIMITS.RECOVERY_MAX_ATTEMPTS_MAX,
        name: "RECORDING_RECOVERY_MAX_ATTEMPTS",
      }
    ),
    recordingAccessLinkTtlSeconds: parseBoundedInt(
      envSource.RECORDING_ACCESS_LINK_TTL_SECONDS,
      {
        def: RECORDING_LIMITS.ACCESS_LINK_TTL_SECONDS_DEFAULT,
        min: RECORDING_LIMITS.ACCESS_LINK_TTL_SECONDS_MIN,
        max: RECORDING_LIMITS.ACCESS_LINK_TTL_SECONDS_MAX,
        name: "RECORDING_ACCESS_LINK_TTL_SECONDS",
      }
    ),
    webhookMaxBytes: parseBoundedInt(envSource.WEBHOOK_MAX_BYTES, {
      def: RECORDING_LIMITS.WEBHOOK_MAX_BYTES_DEFAULT,
      min: RECORDING_LIMITS.WEBHOOK_MAX_BYTES_MIN,
      max: RECORDING_LIMITS.WEBHOOK_MAX_BYTES_MAX,
      name: "WEBHOOK_MAX_BYTES",
    }),
    transcriptionProvider: parseTranscriptionProvider(
      envSource.TRANSCRIPTION_PROVIDER
    ),
    geminiApiKey: parseOptionalString(envSource.GEMINI_API_KEY),
    geminiModel: parseGeminiModel(envSource.GEMINI_MODEL),
    redisUrl: parseOptionalString(envSource.REDIS_URL),
    transcriptChunkMs: parseBoundedInt(envSource.TRANSCRIPT_CHUNK_MS, {
      def: TRANSCRIPTION_LIMITS.CHUNK_MS_DEFAULT,
      min: TRANSCRIPTION_LIMITS.CHUNK_MS_MIN,
      max: TRANSCRIPTION_LIMITS.CHUNK_MS_MAX,
      name: "TRANSCRIPT_CHUNK_MS",
    }),
    transcriptOverlapMs: parseBoundedInt(envSource.TRANSCRIPT_OVERLAP_MS, {
      def: TRANSCRIPTION_LIMITS.OVERLAP_MS_DEFAULT,
      min: TRANSCRIPTION_LIMITS.OVERLAP_MS_MIN,
      max: TRANSCRIPTION_LIMITS.OVERLAP_MS_MAX,
      name: "TRANSCRIPT_OVERLAP_MS",
    }),
    transcriptMaxChunks: parseBoundedInt(envSource.TRANSCRIPT_MAX_CHUNKS, {
      def: TRANSCRIPTION_LIMITS.MAX_CHUNKS_DEFAULT,
      min: TRANSCRIPTION_LIMITS.MAX_CHUNKS_MIN,
      max: TRANSCRIPTION_LIMITS.MAX_CHUNKS_MAX,
      name: "TRANSCRIPT_MAX_CHUNKS",
    }),
    transcriptMaxAudioBytes: parseBoundedInt(
      envSource.TRANSCRIPT_MAX_AUDIO_BYTES,
      {
        def: TRANSCRIPTION_LIMITS.MAX_AUDIO_BYTES_DEFAULT,
        min: TRANSCRIPTION_LIMITS.MAX_AUDIO_BYTES_MIN,
        max: TRANSCRIPTION_LIMITS.MAX_AUDIO_BYTES_MAX,
        name: "TRANSCRIPT_MAX_AUDIO_BYTES",
      }
    ),
    transcriptMaxAudioMs: parseBoundedInt(envSource.TRANSCRIPT_MAX_AUDIO_MS, {
      def: TRANSCRIPTION_LIMITS.MAX_AUDIO_MS_DEFAULT,
      min: TRANSCRIPTION_LIMITS.MAX_AUDIO_MS_MIN,
      max: TRANSCRIPTION_LIMITS.MAX_AUDIO_MS_MAX,
      name: "TRANSCRIPT_MAX_AUDIO_MS",
    }),
    transcriptWorkerConcurrency: parseBoundedInt(
      envSource.TRANSCRIPT_WORKER_CONCURRENCY,
      {
        def: TRANSCRIPTION_LIMITS.WORKER_CONCURRENCY_DEFAULT,
        min: TRANSCRIPTION_LIMITS.WORKER_CONCURRENCY_MIN,
        max: TRANSCRIPTION_LIMITS.WORKER_CONCURRENCY_MAX,
        name: "TRANSCRIPT_WORKER_CONCURRENCY",
      }
    ),
    transcriptQueueMaxWaiting: parseBoundedInt(
      envSource.TRANSCRIPT_QUEUE_MAX_WAITING,
      {
        def: TRANSCRIPTION_LIMITS.QUEUE_MAX_WAITING_DEFAULT,
        min: TRANSCRIPTION_LIMITS.QUEUE_MAX_WAITING_MIN,
        max: TRANSCRIPTION_LIMITS.QUEUE_MAX_WAITING_MAX,
        name: "TRANSCRIPT_QUEUE_MAX_WAITING",
      }
    ),
    transcriptJobAttempts: parseBoundedInt(envSource.TRANSCRIPT_JOB_ATTEMPTS, {
      def: TRANSCRIPTION_LIMITS.JOB_ATTEMPTS_DEFAULT,
      min: TRANSCRIPTION_LIMITS.JOB_ATTEMPTS_MIN,
      max: TRANSCRIPTION_LIMITS.JOB_ATTEMPTS_MAX,
      name: "TRANSCRIPT_JOB_ATTEMPTS",
    }),
    transcriptStepTimeoutMs: parseBoundedInt(
      envSource.TRANSCRIPT_STEP_TIMEOUT_MS,
      {
        def: TRANSCRIPTION_LIMITS.STEP_TIMEOUT_MS_DEFAULT,
        min: TRANSCRIPTION_LIMITS.STEP_TIMEOUT_MS_MIN,
        max: TRANSCRIPTION_LIMITS.STEP_TIMEOUT_MS_MAX,
        name: "TRANSCRIPT_STEP_TIMEOUT_MS",
      }
    ),
    transcriptRunTimeoutMs: parseBoundedInt(
      envSource.TRANSCRIPT_RUN_TIMEOUT_MS,
      {
        def: TRANSCRIPTION_LIMITS.RUN_TIMEOUT_MS_DEFAULT,
        min: TRANSCRIPTION_LIMITS.RUN_TIMEOUT_MS_MIN,
        max: TRANSCRIPTION_LIMITS.RUN_TIMEOUT_MS_MAX,
        name: "TRANSCRIPT_RUN_TIMEOUT_MS",
      }
    ),
    transcriptMaxCallsPerDay: parseBoundedInt(
      envSource.TRANSCRIPT_MAX_CALLS_PER_DAY,
      {
        def: TRANSCRIPTION_LIMITS.MAX_CALLS_PER_DAY_DEFAULT,
        min: TRANSCRIPTION_LIMITS.MAX_CALLS_PER_DAY_MIN,
        max: TRANSCRIPTION_LIMITS.MAX_CALLS_PER_DAY_MAX,
        name: "TRANSCRIPT_MAX_CALLS_PER_DAY",
      }
    ),
    intelligenceProvider: parseIntelligenceProvider(
      envSource.INTELLIGENCE_PROVIDER
    ),
    intelWorkerConcurrency: parseBoundedInt(
      envSource.INTEL_WORKER_CONCURRENCY,
      {
        def: INTELLIGENCE_LIMITS.WORKER_CONCURRENCY_DEFAULT,
        min: INTELLIGENCE_LIMITS.WORKER_CONCURRENCY_MIN,
        max: INTELLIGENCE_LIMITS.WORKER_CONCURRENCY_MAX,
        name: "INTEL_WORKER_CONCURRENCY",
      }
    ),
    intelQueueMaxWaiting: parseBoundedInt(
      envSource.INTEL_QUEUE_MAX_WAITING,
      {
        def: INTELLIGENCE_LIMITS.QUEUE_MAX_WAITING_DEFAULT,
        min: INTELLIGENCE_LIMITS.QUEUE_MAX_WAITING_MIN,
        max: INTELLIGENCE_LIMITS.QUEUE_MAX_WAITING_MAX,
        name: "INTEL_QUEUE_MAX_WAITING",
      }
    ),
    intelJobAttempts: parseBoundedInt(envSource.INTEL_JOB_ATTEMPTS, {
      def: INTELLIGENCE_LIMITS.JOB_ATTEMPTS_DEFAULT,
      min: INTELLIGENCE_LIMITS.JOB_ATTEMPTS_MIN,
      max: INTELLIGENCE_LIMITS.JOB_ATTEMPTS_MAX,
      name: "INTEL_JOB_ATTEMPTS",
    }),
    intelStepTimeoutMs: parseBoundedInt(
      envSource.INTEL_STEP_TIMEOUT_MS,
      {
        def: INTELLIGENCE_LIMITS.STEP_TIMEOUT_MS_DEFAULT,
        min: INTELLIGENCE_LIMITS.STEP_TIMEOUT_MS_MIN,
        max: INTELLIGENCE_LIMITS.STEP_TIMEOUT_MS_MAX,
        name: "INTEL_STEP_TIMEOUT_MS",
      }
    ),
    intelRunTimeoutMs: parseBoundedInt(
      envSource.INTEL_RUN_TIMEOUT_MS,
      {
        def: INTELLIGENCE_LIMITS.RUN_TIMEOUT_MS_DEFAULT,
        min: INTELLIGENCE_LIMITS.RUN_TIMEOUT_MS_MIN,
        max: INTELLIGENCE_LIMITS.RUN_TIMEOUT_MS_MAX,
        name: "INTEL_RUN_TIMEOUT_MS",
      }
    ),
    intelMaxCallsPerDay: parseBoundedInt(
      envSource.INTEL_MAX_CALLS_PER_DAY,
      {
        def: INTELLIGENCE_LIMITS.MAX_CALLS_PER_DAY_DEFAULT,
        min: INTELLIGENCE_LIMITS.MAX_CALLS_PER_DAY_MIN,
        max: INTELLIGENCE_LIMITS.MAX_CALLS_PER_DAY_MAX,
        name: "INTEL_MAX_CALLS_PER_DAY",
      }
    ),
    intelWindowChars: parseBoundedInt(envSource.INTEL_WINDOW_CHARS, {
      def: INTELLIGENCE_LIMITS.WINDOW_CHARS_DEFAULT,
      min: INTELLIGENCE_LIMITS.WINDOW_CHARS_MIN,
      max: INTELLIGENCE_LIMITS.WINDOW_CHARS_MAX,
      name: "INTEL_WINDOW_CHARS",
    }),
    intelMaxWindows: parseBoundedInt(envSource.INTEL_MAX_WINDOWS, {
      def: INTELLIGENCE_LIMITS.MAX_WINDOWS_DEFAULT,
      min: INTELLIGENCE_LIMITS.MAX_WINDOWS_MIN,
      max: INTELLIGENCE_LIMITS.MAX_WINDOWS_MAX,
      name: "INTEL_MAX_WINDOWS",
    }),
    intelMaxSourceBytes: parseBoundedInt(
      envSource.INTEL_MAX_SOURCE_BYTES,
      {
        def: INTELLIGENCE_LIMITS.MAX_SOURCE_BYTES_DEFAULT,
        min: INTELLIGENCE_LIMITS.MAX_SOURCE_BYTES_MIN,
        max: INTELLIGENCE_LIMITS.MAX_SOURCE_BYTES_MAX,
        name: "INTEL_MAX_SOURCE_BYTES",
      }
    ),
    intelMaxSourceSegments: parseBoundedInt(
      envSource.INTEL_MAX_SOURCE_SEGMENTS,
      {
        def: TRANSCRIPTION_LIMITS.MAX_SEGMENTS_TOTAL_DEFAULT,
        min: 10,
        max: 10000,
        name: "INTEL_MAX_SOURCE_SEGMENTS",
      }
    ),
    // Shared project-wide daily Gemini call budget across the Phase 4
    // and Phase 5 pipelines (see queues/geminiBudget.js). Default 700
    // = TRANSCRIPT_MAX_CALLS_PER_DAY default (500) + INTEL default
    // (200): preserves current admission while capping joint spend.
    // Size against the project's actual Gemini quota; the phase caps
    // subdivide it, they do not grant independent quota.
    geminiSharedMaxCallsPerDay: parseBoundedInt(
      envSource.GEMINI_SHARED_MAX_CALLS_PER_DAY,
      {
        def:
          TRANSCRIPTION_LIMITS.MAX_CALLS_PER_DAY_DEFAULT +
          INTELLIGENCE_LIMITS.MAX_CALLS_PER_DAY_DEFAULT,
        min: 1,
        max: 200000,
        name: "GEMINI_SHARED_MAX_CALLS_PER_DAY",
      }
    ),
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
    cookieSameSite: resolved.cookieSameSite,
    mongoConfigured: Boolean(resolved.mongoUri),
    jwtConfigured: Boolean(resolved.jwtSecret),
    livekitConfigured: Boolean(
      resolved.livekitUrl && resolved.livekitApiKey && resolved.livekitApiSecret
    ),
    recordingProvider: resolved.recordingProvider,
    recordingStorageConfigured: Boolean(resolved.recordingStorageConfigured),
    transcriptionProvider: resolved.transcriptionProvider,
    intelligenceProvider: resolved.intelligenceProvider,
    geminiConfigured: Boolean(resolved.geminiApiKey),
    redisConfigured: Boolean(resolved.redisUrl),
  };
}

function resetEnvCache() {
  cachedEnv = null;
}

module.exports = { loadEnv, getEnv, getSafeEnvSummary, resetEnvCache };
