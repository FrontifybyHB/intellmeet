"use strict";

const crypto = require("node:crypto");
const { S3Client, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const {
  EgressClient,
  RoomServiceClient,
  EgressStatus,
  StartEgressRequest,
  TemplateSource,
  Output,
  FileOutput,
  EncodedFileType,
  StorageConfig,
  S3Upload,
} = require("livekit-server-sdk");
const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const logger = require("../config/logger");

// Provider boundary for LiveKit media-room lifecycle.
//
// Official API selection (reviewed 2026-10-13):
// - StartEgress (unified) is the current recommended call; it needs
//   LiveKit server >= v1.13.5 self-hosted or Cloud, and the
//   roomRecord grant on the server token. It replaces the deprecated
//   StartRoomCompositeEgress family.
//   https://docs.livekit.io/reference/other/egress/api.md
//   https://docs.livekit.io/home/egress/api
// - Room teardown uses RoomService DeleteRoom(room).
//   https://docs.livekit.io/reference/server-sdk-js/classes/RoomServiceClient.html
// - EgressClient.startEgress/stopEgress shape:
//   https://docs.livekit.io/reference/server-sdk-js/classes/EgressClient.html
//
// The backend is CommonJS; livekit-server-sdk 2.19.1 exposes a CommonJS
// export boundary, so the SDK stays isolated here and never leaks into
// controllers or the browser bundle. All provider I/O goes through this module:
// - RECORDING_PROVIDER=disabled (default): fail closed with 503
//   INTEGRATION_BLOCKER. Missing Egress/storage credentials are
//   explicit integration blockers.
// - RECORDING_PROVIDER=mock: deterministic in-process Egress +
//   storage twins implementing the same state machine. Mocks are
//   labeled in code/tests and NEVER presented as real Egress checks.
// - RECORDING_PROVIDER=live: uses the installed SDK and configured
//   private S3-compatible output. Missing credentials fail closed.
//
// Recording format/source decision: ONE room-composite MP4 file to the
// configured private bucket (no convenience second export). MP4 keeps
// review quality high while audio remains extractable for the later
// post-meeting transcription phase.

function blocker(reason) {
  return new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, reason, "INTEGRATION_BLOCKER");
}

// --- Mock twins (tests only) -------------------------------------------
const mockEgress = new Map();
const mockStorage = new Map();
const mockAudio = new Map();
const mockBehavior = {
  failStart: null,
  hangStart: false,
  failStop: false,
  statusOverride: null,
};

function mockResetForTests() {
  mockEgress.clear();
  mockStorage.clear();
  mockAudio.clear();
  mockBehavior.failStart = null;
  mockBehavior.hangStart = false;
  mockBehavior.failStop = false;
  mockBehavior.statusOverride = null;
}

function mockEgressId() {
  return `EG_${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

function liveClients() {
  const env = getEnv();
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    throw blocker("LiveKit recording is not configured.");
  }
  let host;
  try {
    host = new URL(env.livekitUrl).origin.replace(/^ws/, "http");
  } catch {
    throw blocker("LIVEKIT_URL must be a valid LiveKit websocket URL.");
  }
  return {
    env,
    egress: new EgressClient(host, env.livekitApiKey, env.livekitApiSecret),
    room: new RoomServiceClient(host, env.livekitApiKey, env.livekitApiSecret),
  };
}

function buildStorage(env) {
  if (!env.recordingStorageConfigured) {
    throw blocker("Live recording storage is not configured.");
  }
  return new StorageConfig({
    provider: {
      case: "s3",
      value: new S3Upload({
        accessKey: env.recordingStorageAccessKey,
        secret: env.recordingStorageSecret,
        bucket: env.recordingOutputBucket,
        region: env.recordingStorageRegion,
        endpoint: env.recordingStorageEndpoint,
        forcePathStyle: env.recordingStorageForcePathStyle,
      }),
    },
  });
}

function buildS3Client(env) {
  if (!env.recordingStorageConfigured) {
    throw blocker("Private recording storage is not configured.");
  }
  return new S3Client({
    region: env.recordingStorageRegion,
    endpoint: env.recordingStorageEndpoint,
    forcePathStyle: env.recordingStorageForcePathStyle,
    credentials: {
      accessKeyId: env.recordingStorageAccessKey,
      secretAccessKey: env.recordingStorageSecret,
    },
  });
}

function buildStartEgressRequest({ roomName, bucket, key, format }) {
  const env = getEnv();
  if (bucket !== env.recordingOutputBucket) {
    throw blocker("Recording output bucket does not match server configuration.");
  }
  return new StartEgressRequest({
    roomName,
    source: { case: "template", value: new TemplateSource({ layout: "speaker-dark" }) },
    outputs: [new Output({
      config: {
        case: "file",
        value: new FileOutput({
          fileType: String(format || "mp4").toLowerCase() === "mp4"
            ? EncodedFileType.MP4
            : String(format).toLowerCase() === "mp3"
              ? EncodedFileType.MP3
              : EncodedFileType.OGG,
          filepath: key,
          disableManifest: true,
        }),
      },
    })],
    storage: buildStorage(env),
  });
}

function providerStatusName(status) {
  return typeof status === "number" ? EgressStatus[status] : String(status);
}

function requireLiveCredentials() {
  const env = getEnv();
  if (
    !env.livekitUrl ||
    !env.livekitApiKey ||
    !env.livekitApiSecret ||
    !env.recordingStorageConfigured
  ) {
    throw blocker(
      "Live Egress/storage is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, " +
        "LIVEKIT_API_SECRET and complete private B2 storage configuration."
    );
  }
  return true;
}

// --- Public provider API ------------------------------------------------
async function startRoomCompositeEgress({ roomName, bucket, key, format }) {
  const mode = getEnv().recordingProvider;
  if (mode === "mock") {
    if (mockBehavior.failStart) {
      const code = mockBehavior.failStart;
      mockBehavior.failStart = null;
      const err = new Error("Mock provider start failure.");
      err.code = code;
      throw err;
    }
    if (mockBehavior.hangStart) {
      // Never settles: the caller's bounded timeout must convert this
      // to state "unknown", never to a claim that no Egress exists.
      await new Promise(() => {});
    }
    const egressId = mockEgressId();
    mockEgress.set(egressId, {
      egressId,
      roomName,
      bucket,
      key,
      format,
      status: "EGRESS_STARTING",
      createdAt: Date.now(),
    });
    logger.info("mock_egress_started", { room: roomName });
    return { egressId, status: "EGRESS_STARTING" };
  }
  requireLiveCredentials();
  const { egress } = liveClients();
  const info = await egress.startEgress(buildStartEgressRequest({ roomName, bucket, key, format }));
  return { egressId: info.egressId, status: info.status, roomName: info.roomName };
}

async function stopEgress({ egressId }) {
  const mode = getEnv().recordingProvider;
  if (mode === "mock") {
    if (mockBehavior.failStop) {
      mockBehavior.failStop = false;
      const err = new Error("Mock provider stop failure.");
      err.code = "PROVIDER_STOP_FAILED";
      throw err;
    }
    const record = mockEgress.get(egressId);
    if (!record) {
      // Missing/already-stopped is the defined benign outcome.
      return { ok: true, alreadyStopped: true };
    }
    record.status = "EGRESS_ENDING";
    return { ok: true, alreadyStopped: false };
  }
  requireLiveCredentials();
  const { egress } = liveClients();
  const info = await egress.stopEgress(egressId);
  return { ok: true, status: info.status };
}

async function deleteLivekitRoom({ roomName }) {
  const mode = getEnv().recordingProvider;
  if (mode === "mock") {
    for (const record of mockEgress.values()) {
      if (record.roomName === roomName) {
        record.roomDeleted = true;
      }
    }
    return { ok: true };
  }
  if (mode === "disabled") {
    // End must stay possible without media credentials: room teardown
    // degrades to unknown, admission stays closed regardless.
    return { ok: false, skipped: true, errorCode: "INTEGRATION_BLOCKER" };
  }
  requireLiveCredentials();
  const { room } = liveClients();
  await room.deleteRoom(roomName);
  return { ok: true };
}

async function getEgressStatus({ egressId }) {
  const mode = getEnv().recordingProvider;
  if (mode === "mock") {
    if (mockBehavior.statusOverride) {
      return mockBehavior.statusOverride;
    }
    const record = mockEgress.get(egressId);
    if (!record) {
      return null;
    }
    return { status: record.status, egressId, roomName: record.roomName };
  }
  requireLiveCredentials();
  const { egress } = liveClients();
  const items = await egress.listEgress({ egressId });
  const info = items.find((item) => item.egressId === egressId);
  return info ? { status: providerStatusName(info.status), egressId: info.egressId, roomName: info.roomName } : null;
}

// Private-output existence check through the configured storage API.
// Never fetches a webhook/client URL; only bucket/key under config.
async function verifyStoredOutput({ bucket, key, providerEgressId }) {
  const mode = getEnv().recordingProvider;
  if (mode === "mock") {
    const stored = mockStorage.get(`${bucket}/${key}`);
    if (!stored) {
      return null;
    }
    return { sizeBytes: stored.sizeBytes, durationMs: stored.durationMs };
  }
  requireLiveCredentials();
  const env = getEnv();
  let head;
  try {
    head = await buildS3Client(env).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    const safe = new Error("Private recording output could not be verified.");
    safe.code = err && (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404)
      ? "OUTPUT_MISSING"
      : "STORAGE_VERIFY_FAILED";
    throw safe;
  }
  if (!Number.isFinite(Number(head.ContentLength)) || Number(head.ContentLength) <= 0) {
    return null;
  }
  let durationMs = null;
  const { egress } = liveClients();
  const items = await egress.listEgress(providerEgressId ? { egressId: providerEgressId } : {});
  for (const info of items) {
    const result = (info.fileResults || []).find((file) => {
      const location = String(file.location || "");
      const filename = String(file.filename || "");
      return filename === key || location.endsWith(`/${key}`) || location.endsWith(key);
    });
    if (result && Number(result.duration) >= 0) {
      durationMs = Number(result.duration) / 1e6;
      break;
    }
  }
  return { sizeBytes: Number(head.ContentLength), durationMs };
}

async function getPrivateObjectUrl({ bucket, key }) {
  const env = getEnv();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(buildS3Client(env), command, {
    expiresIn: env.recordingAccessLinkTtlSeconds,
  });
}

async function readStoredObject({ bucket, key, maxBytes }) {
  const env = getEnv();
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : env.transcriptMaxAudioBytes;
  const response = await buildS3Client(env).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (Number.isFinite(Number(response.ContentLength)) && Number(response.ContentLength) > limit) {
    const error = new Error("Stored recording exceeds the configured read limit.");
    error.code = "AUDIO_TOO_LARGE";
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.Body) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error("Stored recording exceeds the configured read limit.");
      error.code = "AUDIO_TOO_LARGE";
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

function mockPutTestObject({ bucket, key, sizeBytes, durationMs }) {
  mockStorage.set(`${bucket}/${key}`, {
    sizeBytes: sizeBytes || 1024,
    durationMs: durationMs || 1000,
  });
}

// Phase 4 test-only: store retrievable audio bytes for a locator.
// Production mock objects carry metadata only; transcription tests
// inject real (synthesized) WAV bytes through this registry so the
// worker exercises the genuine bytes path end to end.
function mockPutAudioBytesForTests({ bucket, key, bytes, durationMs }) {
  const stored = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes || []);
  mockAudio.set(`${bucket}/${key}`, stored);
  mockStorage.set(`${bucket}/${key}`, {
    sizeBytes: stored.length,
    durationMs: Number.isFinite(durationMs) ? durationMs : 1000,
  });
}

function readMockAudioBytesForTests({ bucket, key }) {
  const stored = mockAudio.get(`${bucket}/${key}`);
  return stored ? Buffer.from(stored) : null;
}

function mockSetEgressStatus(egressId, status) {
  const record = mockEgress.get(egressId);
  if (record) {
    record.status = status;
  }
}

module.exports = {
  startRoomCompositeEgress,
  stopEgress,
  deleteLivekitRoom,
  getEgressStatus,
  verifyStoredOutput,
  getPrivateObjectUrl,
  readStoredObject,
  buildStartEgressRequest,
  mockResetForTests,
  mockPutTestObject,
  mockPutAudioBytesForTests,
  readMockAudioBytesForTests,
  mockSetEgressStatus,
  mockBehavior,
};
