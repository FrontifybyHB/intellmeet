"use strict";

// Provider boundary for Gemini meeting-intelligence generation.
//
// API selection (installed @google/genai 2.29.0, same surface the
// Phase 4 transcription adapter verified against the bundled
// genai.d.ts):
// - ai.models.generateContent({ model, contents, config }) with
//   config.responseMimeType "application/json" + config.responseSchema
//   (subset of JSON Schema).
//   https://ai.google.dev/gemini-api/docs/structured-output
// - Rate/quota behavior per
//   https://ai.google.dev/gemini-api/docs/rate-limits — 429/quota are
//   classified terminal vs retryable by message pattern (quota-pattern
//   messages are terminal; bare rate-limit retries inside budget).
// - JS SDK reference: https://googleapis.github.io/js-genai/
// - Model is the configured GEMINI_MODEL (default gemini-2.0-flash,
//   shared with Phase 4); a model change starts a new run version. No
//   "latest-version" copy and no silent upgrade is performed here.
//
// Modes (INTELLIGENCE_PROVIDER):
// - disabled (default): fail closed, 503 INTEGRATION_BLOCKER.
// - mock: deterministic in-process twin. Labeled everywhere; proves
//   orchestration only, never provider quality.
// - live: real SDK calls. Requires GEMINI_API_KEY; auth/quota errors
//   are terminal; 429-burst/5xx/network are retryable in budget.
//
// The adapter sends transcript text only (bounded windows with segment
// ids); no emails, profiles, cookies, secrets, or other meetings. No
// provider input/output/content logging. No tools/function calls.

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");

function blocker(reason) {
  return new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, reason, "INTEGRATION_BLOCKER");
}

const mockBehavior = {
  failGenerate: null,
  hangGenerate: false,
  malformedOutput: false,
  truncatedOutput: false,
  emptyOutput: false,
  latencyMs: 0,
};

// Window-key -> canned payload. Tests pin the expected validated
// output per source window; a fixture match is pipeline mechanics
// only — never a quality claim.
const mockResponses = new Map();

function mockResetIntelligenceForTests() {
  mockBehavior.failGenerate = null;
  mockBehavior.hangGenerate = false;
  mockBehavior.malformedOutput = false;
  mockBehavior.truncatedOutput = false;
  mockBehavior.emptyOutput = false;
  mockBehavior.latencyMs = 0;
  mockResponses.clear();
}

function mockRegisterIntelligenceResponse(windowKey, payload) {
  mockResponses.set(String(windowKey), payload);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

function classifyLiveError(err) {
  const message = String((err && err.message) || "");
  // Our own step-timeout abort surfaces as an AbortError from the SDK
  // layer: the call outcome is unknown (may still bill server-side),
  // so it stays PROVIDER_TIMEOUT — bounded-retryable, never silent.
  if ((err && err.name === "AbortError") || /aborted|AbortError/i.test(message)) {
    const out = new Error("Gemini call timed out.");
    out.code = "PROVIDER_TIMEOUT";
    return out;
  }
  const status = err && (err.status || err.statusCode || err.code);
  const numeric = Number(status);
  if (
    numeric === 401 ||
    numeric === 403 ||
    /API key not valid|API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED/i.test(message)
  ) {
    const out = new Error("Gemini credentials rejected.");
    out.code = "PROVIDER_AUTH_FAILED";
    return out;
  }
  if (numeric === 429 || /RESOURCE_EXHAUSTED|quota|QuotaExceeded/i.test(message)) {
    if (/quota|QuotaExceeded/i.test(message)) {
      const out = new Error("Gemini quota exhausted.");
      out.code = "PROVIDER_QUOTA_EXHAUSTED";
      return out;
    }
    const out = new Error("Gemini rate limited.");
    out.code = "PROVIDER_RATE_LIMITED";
    return out;
  }
  if (/safety|blocked.*safety|HARM_CATEGORY/i.test(message)) {
    const out = new Error("Provider safety block.");
    out.code = "OUTPUT_SAFETY_BLOCKED";
    return out;
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) {
    const out = new Error("Gemini call failed transiently.");
    out.code = "PROVIDER_UNAVAILABLE";
    return out;
  }
  if (Number.isInteger(numeric) && numeric >= 500) {
    const out = new Error("Gemini unavailable.");
    out.code = "PROVIDER_UNAVAILABLE";
    return out;
  }
  const out = new Error("Gemini call failed.");
  out.code = "PROVIDER_FAILED";
  return out;
}

function requireLiveClient() {
  const env = getEnv();
  if (!env.geminiApiKey) {
    throw blocker("Meeting intelligence is not configured. Set GEMINI_API_KEY and INTELLIGENCE_PROVIDER=live.");
  }
  let sdk;
  try {
    sdk = require("@google/genai");
  } catch (_unused) {
    throw blocker("@google/genai is not installed.");
  }
  return new sdk.GoogleGenAI({ apiKey: env.geminiApiKey });
}

function abortError() {
  const err = new Error("Aborted.");
  err.code = "CANCELLED";
  return err;
}

// Abort-aware sleep for the mock twin: a runner step-timeout aborts
// the wait instead of leaking a hung promise past the test.
function abortableSleep(ms, signal) {
  if (!signal || typeof signal.aborted !== "boolean") {
    return sleep(ms);
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    function cleanup() {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch (_unused) {
        // Listener removal is best-effort.
      }
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// One bounded generateContent call for a single source window (map) or
// the reconcile stage (reduce). Returns the raw parsed payload —
// validation happens in the service layer, never trusted here.
//
// Cancellation boundary (installed @google/genai 2.29.0,
// GenerateContentConfig.abortSignal): aborting frees OUR wait and the
// HTTP socket promptly, but the SDK documents it as client-only — the
// request may still complete server-side and bill. Callers therefore
// treat a timed-out call's outcome as UNKNOWN: writes stay idempotent
// (upserts + validation) and retries stay inside the bounded attempt
// budget, but exactly-once billing is never claimed.
async function generateIntelligence({ windowKey, prompt, responseSchema, signal, onCall }) {
  const mode = getEnv().intelligenceProvider;
  if (mode === "mock") {
    if (mockBehavior.latencyMs > 0) {
      await abortableSleep(mockBehavior.latencyMs, signal);
    }
    if (signal && signal.aborted) {
      throw abortError();
    }
    if (mockBehavior.hangGenerate) {
      await abortableSleep(3600000, signal);
    }
    if (mockBehavior.failGenerate) {
      const code = mockBehavior.failGenerate;
      mockBehavior.failGenerate = null;
      const err = new Error("Mock generate failure.");
      err.code = code;
      throw err;
    }
    if (mockBehavior.malformedOutput) {
      mockBehavior.malformedOutput = false;
      return { __malformed: "not-an-object]][" };
    }
    if (mockBehavior.truncatedOutput) {
      mockBehavior.truncatedOutput = false;
      const err = new Error("Mock truncated output.");
      err.code = "OUTPUT_TRUNCATED";
      throw err;
    }
    if (mockBehavior.emptyOutput) {
      mockBehavior.emptyOutput = false;
      return { summaryBullets: [], decisions: [], blockers: [], unresolvedQuestions: [], suggestedActions: [] };
    }
    const canned = mockResponses.get(String(windowKey || "default"));
    if (canned) {
      return JSON.parse(JSON.stringify(canned));
    }
    return { summaryBullets: [], decisions: [], blockers: [], unresolvedQuestions: [], suggestedActions: [] };
  }
  if (mode !== "live") {
    throw blocker("Meeting intelligence provider is not enabled.");
  }
  const ai = requireLiveClient();
  const env = getEnv();
  if (onCall) {
    await onCall();
  }
  try {
    const response = await ai.models.generateContent({
      model: env.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0,
        maxOutputTokens: 8192,
        // Frees our wait on step-timeout; documented client-only
        // (server may still bill) — see the boundary note above.
        ...(signal ? { abortSignal: signal } : {}),
      },
    });
    const finish =
      response && response.candidates && response.candidates[0] && response.candidates[0].finishReason;
    if (finish && finish !== "STOP") {
      if (finish === "SAFETY") {
        const err = new Error("Provider safety block.");
        err.code = "OUTPUT_SAFETY_BLOCKED";
        throw err;
      }
      if (finish === "MAX_TOKENS") {
        const err = new Error("Provider output truncated.");
        err.code = "OUTPUT_TRUNCATED";
        throw err;
      }
      const err = new Error("Provider finished abnormally.");
      err.code = "OUTPUT_INCOMPLETE";
      err.finishReason = finish;
      throw err;
    }
    const text = typeof response.text === "function" ? response.text() : response.text;
    if (typeof text !== "string" || text.length === 0) {
      const err = new Error("Provider returned no text.");
      err.code = "OUTPUT_INCOMPLETE";
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_unused) {
      const err = new Error("Provider returned malformed JSON.");
      err.code = "OUTPUT_MALFORMED";
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err && err.code && typeof err.code === "string") {
      throw err;
    }
    throw classifyLiveError(err);
  }
}

module.exports = {
  generateIntelligence,
  mockBehavior,
  mockRegisterIntelligenceResponse,
  mockResetIntelligenceForTests,
};
