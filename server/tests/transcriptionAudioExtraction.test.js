"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractMp4Audio } = require("../src/services/transcriptionAudio");

test("MP4 transcription reports a missing ffmpeg binary explicitly", async () => {
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = "/nonexistent/intellmeet-ffmpeg";
  try {
    await assert.rejects(extractMp4Audio(Buffer.from("not a video"), 1024), {
      code: "EXTRACTION_UNAVAILABLE",
    });
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
  }
});
