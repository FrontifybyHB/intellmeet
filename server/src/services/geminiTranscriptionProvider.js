"use strict";

const fs = require("node:fs");

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const logger = require("../config/logger");

// Provider boundary for Google Gemini audio transcription.
//
// API selection (installed @google/genai 2.29.0, verified against the
// bundled genai.d.ts + official docs 2026-10-13):
// - Files API: ai.files.upload({file, config:{mimeType}}) ->
//   ai.files.get({name}) poll until state ACTIVE ->
//   ai.models.generateContent({model, contents, config}) ->
//   ai.files.delete({name}) best-effort cleanup.
//   https://ai.google.dev/gemini-api/docs/audio
//   https://ai.google.dev/gemini-api/docs/generate-content/files
// - Structured output: config.responseMimeType "application/json" +
//   config.responseSchema (subset of JSON Schema).
//   https://ai.google.dev/gemini-api/docs/structured-output
// - The dedicated gemini-3.5-transcribe model returns unstructured
//   prose (audioTranscriptionConfig VERBATIM/SMART modes), which does
//   NOT satisfy the machine-validated segment contract, so the
//   documented audio-understanding + bounded structured-output path is
//   used on the configured GEMINI_MODEL. Model/prompt/schema versions
//   are pinned per run; a model change starts a new run version.
//
// Modes (TRANSCRIPTION_PROVIDER):
// - disabled (default): fail closed, 503 INTEGRATION_BLOCKER.
// - mock: deterministic in-process twin. Labeled everywhere; proves
//   orchestration only, never provider quality.
// - live: real SDK calls. Requires GEMINI_API_KEY; auth/quota errors
//   are terminal (never retried forever); 429/5xx/network are
//   retryable inside the bounded budget.
//
// The adapter never invents SDK options: only generateContent fields
// present in the installed SDK are used.

function blocker(reason) {
  return new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, reason, "INTEGRATION_BLOCKER");
}

// --- Mock twin (tests only) ------------------------------------------
const mockBehavior = {
  failUpload: null,
  failGenerate: null,
  hangGenerate: false,
  malformedOutput: false,
  truncatedOutput: false,
  emptyOutput: false,
  latencyMs: 0,
};

// Reference registry: audioHash -> { segments: [{startMs,endMs,text,
// language?,speakerLabel?}] }. Tests register the expected transcript
// for a fixture so the mock exercises validation/publish mechanics.
// A fixture match is pipeline mechanics only — never a quality claim.
const mockReferences = new Map();

function mockResetTranscriptionForTests() {
  mockBehavior.failUpload = null;
  mockBehavior.failGenerate = null;
  mockBehavior.hangGenerate = false;
  mockBehavior.malformedOutput = false;
  mockBehavior.truncatedOutput = false;
  mockBehavior.emptyOutput = false;
  mockBehavior.latencyMs = 0;
  mockReferences.clear();
}

function mockRegisterReference(audioHash, reference) {
  mockReferences.set(audioHash, reference);
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
  const status =
    (err && (err.status || err.statusCode || err.code)) || null;
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
  if (
    numeric === 429 ||
    /RESOURCE_EXHAUSTED|quota|QuotaExceeded/i.test(message)
  ) {
    // Sustained quota exhaustion is terminal; burst rate limiting is
    // retryable. The adapter cannot distinguish them from status
    // alone, so quota-pattern messages are terminal while bare 429s
    // retry inside the budget.
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
    throw blocker(
      "Gemini transcription is not configured. Set GEMINI_API_KEY and TRANSCRIPTION_PROVIDER=live."
    );
  }
  let sdk;
  try {
    sdk = require("@google/genai");
  } catch (_unused) {
    throw blocker("@google/genai is not installed.");
  }
  return new sdk.GoogleGenAI({ apiKey: env.geminiApiKey });
}

// --- Public adapter API -----------------------------------------------
// uploadAudioForTranscription: stage provider-side input, wait for
// ACTIVE, return the private file identity. Never a public URL.
async function uploadAudioForTranscription({ bytes, mimeType, displayName, signal, onCall }) {
  const mode = getEnv().transcriptionProvider;
  if (mode === "mock") {
    if (mockBehavior.latencyMs > 0) {
      await sleep(mockBehavior.latencyMs);
    }
    if (signal && signal.aborted) {
      const err = new Error("Aborted.");
      err.code = "CANCELLED";
      throw err;
    }
    if (mockBehavior.failUpload) {
      const code = mockBehavior.failUpload;
      mockBehavior.failUpload = null;
      const err = new Error("Mock upload failure.");
      err.code = code;
      throw err;
    }
    const name = `files/mock-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
    return { fileName: name, uri: name, state: "ACTIVE", mock: true };
  }
  if (mode !== "live") {
    throw blocker("Transcription provider is not enabled.");
  }
  const ai = requireLiveClient();
  const started = Date.now();
  const tmpPath = require("./transcriptionAudio");
  const dir = tmpPath.makeRunTempDir(`upload-${Date.now()}`);
  const localPath = `${dir}/chunk.wav`;
  try {
    fs.writeFileSync(localPath, bytes);
    if (onCall) {
      onCall();
    }
    const uploaded = await ai.files.upload({
      file: localPath,
      config: { mimeType, displayName: displayName || "meeting-audio" },
    });
    const fileName = uploaded && uploaded.name;
    if (!fileName) {
      throw Object.assign(new Error("Upload returned no file."), {
        code: "PROVIDER_FAILED",
      });
    }
    // Bounded ACTIVE poll; expiry/FAILED surfaces terminally.
    const env = getEnv();
    const intervalMs = 3000;
    const maxPolls = 20;
    for (let i = 0; i < maxPolls; i += 1) {
      if (signal && signal.aborted) {
        try {
          await ai.files.delete({ name: fileName });
        } catch (_unused) {
          // Best-effort remote cleanup; local cancel still wins.
        }
        const err = new Error("Aborted.");
        err.code = "CANCELLED";
        throw err;
      }
      const current = await ai.files.get({ name: fileName });
      if (current && current.state === "ACTIVE") {
        logger.info("gemini_file_active", { latencyMs: Date.now() - started });
        return { fileName, uri: current.uri || fileName, state: "ACTIVE", mock: false };
      }
      if (current && current.state === "FAILED") {
        const err = new Error("Provider file processing failed.");
        err.code = "PROVIDER_FAILED";
        throw err;
      }
      await sleep(intervalMs);
    }
    const err = new Error("Provider file never became active.");
    err.code = "PROVIDER_FILE_EXPIRED";
    try {
      await ai.files.delete({ name: fileName });
    } catch (_unused) {
      // Best-effort.
    }
    throw err;
  } catch (err) {
    if (err && err.code && typeof err.code === "string") {
      throw err;
    }
    throw classifyLiveError(err);
  } finally {
    tmpPath.removeDirSync(dir);
  }
}

// transcribeChunkAudio: one bounded generateContent call for a single
// chunk. Returns the raw parsed payload (validation happens in the
// service layer, never trusted here).
async function transcribeChunkAudio({ fileRef, prompt, responseSchema, signal, onCall }) {
  const mode = getEnv().transcriptionProvider;
  if (mode === "mock") {
    if (mockBehavior.latencyMs > 0) {
      await sleep(mockBehavior.latencyMs);
    }
    if (signal && signal.aborted) {
      const err = new Error("Aborted.");
      err.code = "CANCELLED";
      throw err;
    }
    if (mockBehavior.hangGenerate) {
      await new Promise(() => {});
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
      err.partial = { segments: [] };
      throw err;
    }
    if (mockBehavior.emptyOutput) {
      mockBehavior.emptyOutput = false;
      return { segments: [] };
    }
    const ref =
      mockReferences.get(fileRef && fileRef.chunkAudioHash) ||
      mockReferences.get(fileRef && fileRef.audioHash);
    if (!ref) {
      return { segments: [] };
    }
    return { segments: ref.segments || [] };
  }
  if (mode !== "live") {
    throw blocker("Transcription provider is not enabled.");
  }
  const ai = requireLiveClient();
  const env = getEnv();
  if (onCall) {
    onCall();
  }
  try {
    const sdk = require("@google/genai");
    const filePart = sdk.createPartFromUri(fileRef.uri, fileRef.mimeType);
    const response = await ai.models.generateContent({
      model: env.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }, filePart] }],
      config: {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0,
        maxOutputTokens: 8192,
      },
    });
    const finish =
      response &&
      response.candidates &&
      response.candidates[0] &&
      response.candidates[0].finishReason;
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

// deleteProviderFile: best-effort remote cleanup. Returns true when the
// API confirmed deletion; false otherwise (never throws — callers
// record remoteCleanupRequested instead of failing the run on it).
async function deleteProviderFile({ fileName }) {
  const mode = getEnv().transcriptionProvider;
  if (mode === "mock" || !fileName || /^(files\/)?mock-/.test(String(fileName))) {
    return true;
  }
  if (mode !== "live") {
    return false;
  }
  try {
    const ai = requireLiveClient();
    await ai.files.delete({ name: fileName });
    return true;
  } catch (_unused) {
    return false;
  }
}

module.exports = {
  uploadAudioForTranscription,
  transcribeChunkAudio,
  deleteProviderFile,
  mockBehavior,
  mockRegisterReference,
  mockResetTranscriptionForTests,
};
