"use strict";

const express = require("express");

const { getEnv } = require("../config/env");
const { livekitWebhook } = require("../controllers/livekitWebhookController");

const router = express.Router();

// Route-scoped bounded raw parser for the LiveKit content type ONLY.
// It runs here — not globally — so the global JSON parser can never
// corrupt the original bytes the signature verifier requires.
// Reference: livekit-server-sdk WebhookReceiver + npm webhook guide:
// app.use(express.raw({ type: "application/webhook+json" })).
router.post(
  "/livekit",
  express.raw({
    type: "application/webhook+json",
    limit: (() => {
      try {
        return getEnv().webhookMaxBytes;
      } catch (_unused) {
        return 65536;
      }
    })(),
  }),
  livekitWebhook
);

module.exports = router;
