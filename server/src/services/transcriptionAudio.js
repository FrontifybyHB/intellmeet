"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { TRANSCRIPTION_LIMITS } = require("../constants/transcriptionLimits");
const logger = require("../config/logger");

// Private audio resolution + preparation for transcription.
//
// Input rule: bytes come ONLY from the Phase 3 server-selected
// private locator (bucket/key) through the configured storage reader
// — never from client/webhook URLs (no fetch, no redirects, no SSRF
// surface). Format handling without a media toolchain on this host:
// - WAV (linear PCM, 16-bit) is parsed and sliced in-process for
//   chunking; no subprocess, no shell, bounded buffers.
// - Recorded MP4 needs ffmpeg on the transcription worker host to decode
//   its audio track into the PCM WAV format used by the chunker.
// - Missing/empty/silent input is a distinct outcome (NO_AUDIO), not
//   invented text.
//
// Temp discipline: per-run private directory under os.tmpdir(),
// bounded total bytes, removed in finally by the caller; a janitor
// (sweepStaleTempDirs) covers crashes. Disk usage of one run is
// bounded by 2x source bytes (source copy + largest chunk).

const WAV_MIME_HINTS = new Set(
  TRANSCRIPTION_LIMITS.WAV_MIME_TYPES.map((mime) => String(mime).toLowerCase())
);

function tempRoot() {
  return path.join(os.tmpdir(), "intellmeet-transcript");
}

function makeRunTempDir(runId) {
  const safe = String(runId || "run").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const dir = path.join(
    tempRoot(),
    `${safe}-${crypto.randomBytes(6).toString("hex")}`
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function removeDirSync(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch (err) {
    logger.error("transcript_temp_cleanup_failed", {});
  }
}

// Remove crashed-run temp dirs older than maxAgeMs. Bounded: scans one
// directory level, caps removals per call.
function sweepStaleTempDirs(maxAgeMs, maxRemovals) {
  const root = tempRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_unused) {
    return { removed: 0 };
  }
  const now = Date.now();
  const cap = Number.isInteger(maxRemovals) ? maxRemovals : 20;
  let removed = 0;
  for (const entry of entries) {
    if (removed >= cap || !entry.isDirectory()) {
      continue;
    }
    const full = path.join(root, entry.name);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch (_unused) {
      continue;
    }
    if (now - stat.mtimeMs > maxAgeMs) {
      removeDirSync(full);
      removed += 1;
    }
  }
  return { removed };
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Minimal RIFF/WAVE parser for 16-bit PCM (the only format chunked
// in-process). Returns { sampleRate, channels, bitsPerSample,
// dataOffset, dataBytes, durationMs }. Throws AUDIO_FORMAT_UNSUPPORTED
// for anything else — never guesses.
function parseWav(buffer) {
  const fail = () =>
    new AppError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      "Audio is not supported 16-bit PCM WAV.",
      "AUDIO_FORMAT_UNSUPPORTED"
    );
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw fail();
  }
  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw fail();
  }
  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataBytes = -1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      if (size < 16 || offset + 8 + size > buffer.length) {
        throw fail();
      }
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (
    !format ||
    format.audioFormat !== 1 ||
    format.bitsPerSample !== 16 ||
    dataOffset < 0 ||
    dataBytes < 0 ||
    dataOffset + dataBytes > buffer.length ||
    format.sampleRate <= 0 ||
    format.channels <= 0
  ) {
    throw fail();
  }
  const bytesPerMs = (format.sampleRate * format.channels * 2) / 1000;
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: 16,
    dataOffset,
    dataBytes,
    durationMs: Math.floor(dataBytes / bytesPerMs),
  };
}

function isSilentPcm(buffer, dataOffset, dataBytes) {
  // Bounded scan: sample up to 4096 int16 frames across the span.
  const frames = Math.floor(dataBytes / 2);
  if (frames <= 0) {
    return true;
  }
  const step = Math.max(1, Math.floor(frames / 4096));
  for (let i = 0; i < frames; i += step) {
    if (buffer.readInt16LE(dataOffset + i * 2) !== 0) {
      return false;
    }
  }
  return true;
}

function mimeForFormat(format) {
  const ext = String(format || "").toLowerCase().replace(/^\./, "");
  if (ext === "wav" || ext === "wave") {
    return "audio/wav";
  }
  if (ext === "mp3") {
    return "audio/mp3";
  }
  if (ext === "m4a" || ext === "mp4") {
    return "audio/m4a";
  }
  if (ext === "ogg" || ext === "opus") {
    return "audio/ogg";
  }
  if (ext === "flac") {
    return "audio/flac";
  }
  if (ext === "webm") {
    return "audio/webm";
  }
  return "application/octet-stream";
}

function isDirectlySupportedMime(mime) {
  return WAV_MIME_HINTS.has(String(mime || "").toLowerCase());
}

async function extractMp4Audio(bytes, maxBytes) {
  const dir = makeRunTempDir("mp4");
  const input = path.join(dir, "input.mp4");
  const output = path.join(dir, "audio.wav");
  try {
    fs.writeFileSync(input, bytes, { mode: 0o600 });
    await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", [
      "-nostdin", "-v", "error", "-y", "-i", input,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_s16le", output,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const size = fs.statSync(output).size;
    if (size > maxBytes) {
      throw new AppError(HTTP_STATUS.UNPROCESSABLE_ENTITY, "Extracted audio is too large.", "AUDIO_TOO_LARGE");
    }
    return fs.readFileSync(output);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new AppError(HTTP_STATUS.SERVICE_UNAVAILABLE, "ffmpeg is required on the transcription worker.", "EXTRACTION_UNAVAILABLE");
    }
    if (err instanceof AppError) throw err;
    throw new AppError(HTTP_STATUS.UNPROCESSABLE_ENTITY, "Recording audio could not be extracted.", "AUDIO_FORMAT_UNSUPPORTED");
  } finally {
    removeDirSync(dir);
  }
}

// Slice one WAV chunk [offsetMs, offsetMs+durationMs) into a new valid
// WAV buffer. Pure function over bounded buffers; throws on bounds.
function sliceWavChunk(source, parsed, offsetMs, durationMs) {
  const bytesPerMs = (parsed.sampleRate * parsed.channels * 2) / 1000;
  const startByte = Math.floor(offsetMs * bytesPerMs);
  const lengthBytes = Math.floor(durationMs * bytesPerMs);
  const alignedStart = startByte - (startByte % (parsed.channels * 2));
  const alignedLen = lengthBytes - (lengthBytes % (parsed.channels * 2));
  if (
    alignedStart < 0 ||
    alignedLen <= 0 ||
    alignedStart + alignedLen > parsed.dataBytes
  ) {
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Could not prepare audio.",
      "DB_ERROR"
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + alignedLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(parsed.channels, 22);
  header.writeUInt32LE(parsed.sampleRate, 24);
  header.writeUInt32LE(parsed.sampleRate * parsed.channels * 2, 28);
  header.writeUInt16LE(parsed.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(alignedLen, 40);
  return Buffer.concat([
    header,
    source.subarray(
      parsed.dataOffset + alignedStart,
      parsed.dataOffset + alignedStart + alignedLen
    ),
  ]);
}

// Build the chunk plan for a source of durationMs. Bounded count;
// trailing remainder folds into the last chunk when shorter than the
// overlap so no orphan sliver is created.
function planChunks(durationMs, chunkMs, overlapMs, maxChunks) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new AppError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      "Audio has no playable duration.",
      "NO_AUDIO"
    );
  }
  if (durationMs > chunkMs) {
    const est = Math.ceil(durationMs / chunkMs);
    if (est > maxChunks) {
      const err = new AppError(
        HTTP_STATUS.UNPROCESSABLE_ENTITY,
        "Audio exceeds the transcribable duration budget.",
        "AUDIO_TOO_LONG"
      );
      err.limit = maxChunks * chunkMs;
      throw err;
    }
  }
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < durationMs) {
    const remaining = durationMs - offset;
    let length = Math.min(chunkMs, remaining);
    // Fold a tiny tail into this chunk instead of a sliver chunk.
    if (remaining > chunkMs && remaining - chunkMs < overlapMs) {
      length = remaining;
    }
    chunks.push({ index, offsetMs: offset, durationMs: length });
    if (offset + length >= durationMs) {
      break;
    }
    offset += length - overlapMs;
    index += 1;
    if (chunks.length > maxChunks) {
      const err = new AppError(
        HTTP_STATUS.UNPROCESSABLE_ENTITY,
        "Audio exceeds the transcribable duration budget.",
        "AUDIO_TOO_LONG"
      );
      throw err;
    }
  }
  return chunks;
}

// Synthesize a deterministic 16-bit PCM WAV (test fixtures only):
// tone segments per spec [{freqHz, ms}] interleaved with silence.
function synthesizeWav({ sampleRate, parts }) {
  const rate = sampleRate || 16000;
  const frames = [];
  let total = 0;
  for (const part of parts) {
    const count = Math.floor((rate * part.ms) / 1000);
    total += count;
    frames.push({ count, freqHz: part.freqHz || 0 });
  }
  const data = Buffer.alloc(total * 2);
  let at = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.count; i += 1) {
      let sample = 0;
      if (frame.freqHz > 0) {
        sample = Math.floor(
          12000 * Math.sin((2 * Math.PI * frame.freqHz * (at % rate)) / rate)
        );
      }
      data.writeInt16LE(sample, at * 2);
      at += 1;
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

module.exports = {
  tempRoot,
  makeRunTempDir,
  removeDirSync,
  sweepStaleTempDirs,
  sha256Hex,
  parseWav,
  isSilentPcm,
  mimeForFormat,
  isDirectlySupportedMime,
  extractMp4Audio,
  sliceWavChunk,
  planChunks,
  synthesizeWav,
};
