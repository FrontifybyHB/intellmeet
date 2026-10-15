"use strict";

const crypto = require("node:crypto");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const Meeting = require("../models/Meeting");
const Recording = require("../models/Recording");
const WebhookEvent = require("../models/WebhookEvent");
const { roomNameFor } = require("./meetingJoinService");
const {
  applyProviderEvent,
} = require("./recordingService");
const { publishToMeeting } = require("../sockets/realtime");
const recordingMetrics = require("../utils/recordingMetrics");

// LiveKit webhook verification, mirroring the installed-SDK reference
// (livekit-server-sdk WebhookReceiver.receive(rawBodyString,
// authHeader) — https://docs.livekit.io/home/server/webhooks):
// - Content-Type is application/webhook+json; the route mounts
//   express.raw for that type so verification sees the ORIGINAL bytes
//   (global JSON parsing must never corrupt them).
// - Authorization carries a signed JWT whose claims include the
//   sha256 of the raw payload as BASE64 (official WebhookReceiver:
//   btoa(sha256(rawBytes)); verified 2026-10-13 against
//   livekit-server-sdk WebhookReceiver.ts + Python/Kotlin receivers).
//   Hex digests are additionally accepted for backwards compatibility
//   with previously issued test fixtures — never generated here.
//   Verification checks signature, issuer (API key), and body hash
//   BEFORE any state mutation.
// The SDK is not installed in this repo (see recordingProvider.js),
// so this module implements the equivalent HS256 check with the
// webhook secret (LIVEKIT_WEBHOOK_SECRET override, else
// LIVEKIT_API_SECRET). Webhooks use provider verification — never
// user JWT/CSRF auth.

const KNOWN_EVENTS = new Set([
  "room_started",
  "room_finished",
  "participant_joined",
  "participant_left",
  "egress_started",
  "egress_updated",
  "egress_ended",
]);

function base64UrlToUtf8(input) {
  return Buffer.from(
    String(input).replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function verifyWebhookToken(token, secret) {
  const parts = String(token).split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed webhook token.");
  }
  const [h, p, sig] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid webhook signature.");
  }
  return JSON.parse(base64UrlToUtf8(p));
}

async function verifyLivekitWebhook({ rawBody, authHeader }) {
  const env = getEnv();
  const secret = env.recordingWebhookSecret || env.livekitApiSecret;
  if (!secret) {
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Webhook verification is not configured.",
      "INTEGRATION_BLOCKER"
    );
  }
  if (!authHeader || typeof authHeader !== "string") {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  let body;
  if (Buffer.isBuffer(rawBody)) {
    body = rawBody;
  } else if (typeof rawBody === "string") {
    body = Buffer.from(rawBody, "utf8");
  } else {
    // Wrong content type (e.g. application/json parsed to an object) or
    // missing raw parser output: no trustworthy bytes to verify.
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  const maxBytes = env.webhookMaxBytes;
  if (body.length === 0 || body.length > maxBytes) {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  let claims;
  try {
    claims = verifyWebhookToken(authHeader.trim(), secret);
  } catch (_unused) {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  if (env.livekitApiKey && claims.iss !== env.livekitApiKey) {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && nowSeconds >= claims.exp) {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  const rawDigest = crypto.createHash("sha256").update(body).digest();
  const expectedBase64 = Buffer.from(rawDigest).toString("base64");
  const expectedHex = rawDigest.toString("hex");
  const claimed = String((claims && claims.sha256) || "");
  const candidateBase64 = Buffer.from(expectedBase64);
  const candidateHex = Buffer.from(expectedHex);
  const claimedBytes = Buffer.from(claimed);
  const matchesBase64 =
    claimedBytes.length === candidateBase64.length &&
    crypto.timingSafeEqual(claimedBytes, candidateBase64);
  const matchesHex =
    claimedBytes.length === candidateHex.length &&
    crypto.timingSafeEqual(claimedBytes, candidateHex);
  if (!matchesBase64 && !matchesHex) {
    // Body integrity failure: tampered or re-serialized payload.
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  let event;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch (_unused) {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  if (!event || typeof event !== "object") {
    throw new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid webhook.", "WEBHOOK_REJECTED");
  }
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 128) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Invalid webhook event.", "WEBHOOK_REJECTED");
  }
  if (!KNOWN_EVENTS.has(event.event)) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Unknown webhook event.", "WEBHOOK_REJECTED");
  }
  return event;
}

function meetingIdFromRoomName(roomName) {
  const mongoose = require("mongoose");
  if (typeof roomName !== "string" || !roomName.startsWith("meeting_")) {
    return null;
  }
  const raw = roomName.slice("meeting_".length);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    return null;
  }
  return raw;
}

// Durable webhook application. Duplicate event ids collapse on the
// unique index (valid replay is safe); unknown or mismatched ids are
// recorded as ignored/rejected and NEVER create public records.
// Acknowledgement happens only after the durable write, so a DB
// failure returns 500 and the provider may retry.
async function processWebhookEvent(event) {
  const eventId = event.id;
  const eventName = event.event;
  const egressInfo = event.egressInfo || null;
  const roomPayload = event.room || null;
  const roomName =
    (egressInfo && egressInfo.roomName) || (roomPayload && roomPayload.name) || null;
  const providerEgressId =
    (egressInfo && (egressInfo.egressId || egressInfo.egress_id)) || null;

  let record;
  try {
    record = await WebhookEvent.create({
      eventId,
      event: eventName,
      roomName,
      providerEgressId,
      outcome: "applied",
    });
  } catch (err) {
    if (err && (err.code === 11000 || err.code === "11000")) {
      return { duplicate: true, outcome: "duplicate" };
    }
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Could not process the webhook.",
      "DB_ERROR"
    );
  }

  try {
    if (eventName === "room_finished") {
      await handleRoomFinished({ roomName });
      return { duplicate: false, outcome: "applied" };
    }
    if (eventName === "room_started" || eventName.indexOf("participant_") === 0) {
      // Presence signals only: never trusted for consent or capture
      // state. Recorded for audit; no recording mutation.
      await WebhookEvent.findByIdAndUpdate(record._id, { outcome: "applied" }).lean();
      return { duplicate: false, outcome: "applied" };
    }
    // Egress lifecycle events.
    const result = await handleEgressEvent({
      eventName,
      roomName,
      providerEgressId,
      egressInfo,
      webhookRecordId: record._id,
    });
    return result;
  } catch (err) {
    // Keep the idempotence row but mark the outcome so replays of a
    // poisoned payload stay cheap.
    try {
      await WebhookEvent.findByIdAndUpdate(record._id, { outcome: "rejected" }).lean();
    } catch (_unused) {
      // Marking failure must not mask the original error.
    }
    throw err;
  }
}

async function handleRoomFinished({ roomName }) {
  const meetingRaw = meetingIdFromRoomName(roomName);
  if (!meetingRaw) {
    return;
  }
  // room_finished never reopens or ends the meeting on its own: it
  // only completes the SEPARATE media-cleanup fact when the app has
  // already ended the meeting.
  await Meeting.findOneAndUpdate(
    { _id: meetingRaw, status: "ended" },
    { $set: { "mediaCleanup.state": "done", "mediaCleanup.at": new Date() } }
  ).lean();
}

async function handleEgressEvent({ eventName, roomName, providerEgressId, egressInfo, webhookRecordId }) {
  const status = egressInfo && (egressInfo.status || egressInfo.Status);

  let recording = null;
  if (providerEgressId) {
    recording = await Recording.findOne(
      { providerEgressId },
      { meetingId: 1, sessionId: 1, state: 1 }
    ).lean();
    // Provider-id match is not enough: the payload's room must agree
    // with the attempt's session, or the callback is uncorrelated
    // (wrong room replayed against a known egress id).
    if (recording && roomName && recording.sessionId !== roomName) {
      await WebhookEvent.findByIdAndUpdate(webhookRecordId, {
        outcome: "ignored",
      }).lean();
      return { duplicate: false, outcome: "ignored" };
    }
  }
  if (!recording && roomName && (eventName === "egress_started" || eventName === "egress_updated" || eventName === "egress_ended")) {
    // Webhook arrived before the start response saved the provider id:
    // resolve the known server attempt by session WITHOUT trusting
    // uncorrelated content — the room must match our session naming.
    const meetingRaw = meetingIdFromRoomName(roomName);
    if (meetingRaw) {
      const { findNonterminalAttempt } = require("./recordingService");
      recording = await findNonterminalAttempt(meetingRaw, roomName);
      if (recording && providerEgressId && !recording.providerEgressId) {
        const bound = await Recording.findOneAndUpdate(
          { _id: recording._id, providerEgressId: null },
          { $set: { providerEgressId } }
        ).lean();
        if (bound) {
          recording = { ...recording, providerEgressId };
        } else {
          // Another writer bound a DIFFERENT provider id: do not trust
          // this payload for that attempt.
          const current = await Recording.findById(recording._id, {
            providerEgressId: 1,
          }).lean();
          if (!current || current.providerEgressId !== providerEgressId) {
            await WebhookEvent.findByIdAndUpdate(webhookRecordId, {
              outcome: "ignored",
            }).lean();
            return { duplicate: false, outcome: "ignored" };
          }
          recording = await Recording.findById(recording._id, {
            meetingId: 1,
            sessionId: 1,
            state: 1,
          }).lean();
        }
      } else if (recording && providerEgressId && recording.providerEgressId !== providerEgressId) {
        await WebhookEvent.findByIdAndUpdate(webhookRecordId, {
          outcome: "ignored",
        }).lean();
        return { duplicate: false, outcome: "ignored" };
      }
    }
  }
  if (!recording) {
    await WebhookEvent.findByIdAndUpdate(webhookRecordId, {
      outcome: "ignored",
    }).lean();
    return { duplicate: false, outcome: "ignored" };
  }

  await WebhookEvent.findByIdAndUpdate(webhookRecordId, {
    recordingId: recording._id,
  }).lean();

  const outputMeta =
    providerEgressId && recording.providerEgressId !== providerEgressId
      ? { egressId: providerEgressId }
      : providerEgressId
        ? { egressId: providerEgressId }
        : null;
  const updated = await applyProviderEvent({
    recordingId: recording._id,
    providerStatus: status || eventNameToStatus(eventName),
    outputMeta,
  });
  recordingMetrics.observeWebhookApplied();
  if (updated) {
    const meetingParam = String(updated.meetingId);
    publishToMeeting(roomNameFor(meetingParam), "recording:status", {
      meetingId: meetingParam,
      recording: updated,
    });
    if (updated.state === "ready") {
      publishToMeeting(roomNameFor(meetingParam), "recording:ready", {
        meetingId: meetingParam,
        recordingId: updated.id,
        state: "ready",
      });
    }
  }
  return { duplicate: false, outcome: "applied", recording: updated };
}

function eventNameToStatus(eventName) {
  if (eventName === "egress_started") {
    return "EGRESS_ACTIVE";
  }
  if (eventName === "egress_ended") {
    return "EGRESS_COMPLETE";
  }
  return "EGRESS_ACTIVE";
}

module.exports = {
  verifyLivekitWebhook,
  processWebhookEvent,
  meetingIdFromRoomName,
};
