"use strict";

const crypto = require("node:crypto");

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
// COMPATIBILITY DECISION: livekit-server-sdk is NOT in this repo's
// lockfile (installed: express 4.22.3, mongoose 8.24.5,
// socket.io 4.8.4), and the repo is CommonJS while the v2 SDK is ESM.
// The SDK is therefore NOT added here — no blind upgrades. All
// provider I/O goes through this module:
// - RECORDING_PROVIDER=disabled (default): fail closed with 503
//   INTEGRATION_BLOCKER. Missing Egress/storage credentials are
//   explicit integration blockers.
// - RECORDING_PROVIDER=mock: deterministic in-process Egress +
//   storage twins implementing the same state machine. Mocks are
//   labeled in code/tests and NEVER presented as real Egress checks.
// - RECORDING_PROVIDER=live: reserved. Wiring the real SDK + Twirp
//   calls touches ONLY this file (StartEgress request builder +
//   DeleteRoom/StopEgress below); service logic stays unchanged.
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

// --- Live-mode stubs (isolated) ----------------------------------------
// Build the StartEgress-shaped request the real SDK would send. Kept as
// data (no network) so reviewers can verify parity when wiring "live".
function buildStartEgressRequest({ roomName, bucket, key, format }) {
  return {
    method: "StartEgress",
    roomName,
    source: { case: "template", value: { layout: "speaker-dark", roomName } },
    outputs: [
      {
        case: "file",
        value: {
          fileType: String(format || "mp4").toUpperCase(),
          filepath: key,
          output: { case: "s3", value: { bucket } },
        },
      },
    ],
  };
}

function requireLiveCredentials() {
  const env = getEnv();
  if (
    !env.livekitUrl ||
    !env.livekitApiKey ||
    !env.livekitApiSecret ||
    !env.recordingOutputBucket
  ) {
    throw blocker(
      "Live Egress/storage is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, " +
        "LIVEKIT_API_SECRET and RECORDING_OUTPUT_BUCKET, and install livekit-server-sdk."
    );
  }
  // The SDK itself is still unwired (see module header): report the
  // exact blocker instead of pretending integration passed.
  throw blocker(
    "Live provider requires livekit-server-sdk (StartEgress/DeleteRoom). " +
      "It is not installed; wire it in services/recordingProvider.js only."
  );
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
  return buildStartEgressRequest({ roomName, bucket, key, format });
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
  return { ok: true };
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
  return null;
}

// Private-output existence check through the configured storage API.
// Never fetches a webhook/client URL; only bucket/key under config.
async function verifyStoredOutput({ bucket, key }) {
  const mode = getEnv().recordingProvider;
  if (mode === "mock") {
    const stored = mockStorage.get(`${bucket}/${key}`);
    if (!stored) {
      return null;
    }
    return { sizeBytes: stored.sizeBytes, durationMs: stored.durationMs };
  }
  requireLiveCredentials();
  return null;
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
  buildStartEgressRequest,
  mockResetForTests,
  mockPutTestObject,
  mockPutAudioBytesForTests,
  readMockAudioBytesForTests,
  mockSetEgressStatus,
  mockBehavior,
};
