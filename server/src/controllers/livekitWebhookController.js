"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const {
  verifyLivekitWebhook,
  processWebhookEvent,
} = require("../services/webhookService");
const recordingMetrics = require("../utils/recordingMetrics");

// Verified LiveKit webhook. Provider verification (signature + body
// hash over the ORIGINAL raw bytes) — never user JWT/CSRF auth.
// The route mounts express.raw({ type: "application/webhook+json" })
// so req.body is the untouched Buffer the verifier requires.
// Acknowledgement follows the durable write, so DB failures return
// 500 and the provider may retry; duplicates collapse on the event-id
// unique index and return success.
const livekitWebhook = asyncHandler(async (req, res) => {
  let event;
  try {
    event = await verifyLivekitWebhook({
      rawBody: req.body,
      authHeader: req.get("Authorization"),
    });
  } catch (err) {
    recordingMetrics.observeWebhookReject();
    recordingMetrics.observeReject(err && err.code);
    throw err;
  }
  try {
    const result = await processWebhookEvent(event);
    res.status(HTTP_STATUS.OK).json({ ok: true, ...result });
  } catch (err) {
    recordingMetrics.observeWebhookReject();
    throw err;
  }
});

module.exports = { livekitWebhook };
