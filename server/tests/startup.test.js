"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet";
process.env.NODE_ENV = "test";

const logger = require("../src/config/logger");
const { handleStartupError } = require("../src/server");

describe("startup failure logging", () => {
  it("logs a stable code and error name, never the message", () => {
    const fields = logger.formatStartupFailure(
      Object.assign(new Error("mongodb://admin:s3cret@db/x"), {
        name: "MongoServerError",
      })
    );
    assert.deepEqual(fields, {
      code: "SERVER_START_FAILED",
      name: "MongoServerError",
    });
    assert.ok(
      !JSON.stringify(fields).includes("s3cret"),
      "startup fields leaked secret"
    );
  });

  it("handleStartupError reports without secret leakage", () => {
    const logs = [];
    const original = console.error;
    const previousExitCode = process.exitCode;
    console.error = (line) => logs.push(String(line));
    try {
      const err = new Error("connect failed: LIVEKIT_API_SECRET=shh-s3cret");
      err.name = "MongoServerError";
      handleStartupError(err);
      assert.ok(logs.length > 0, "expected a startup failure log line");
      const line = logs.join("\n");
      assert.ok(line.includes("SERVER_START_FAILED"), "missing stable code");
      assert.ok(line.includes("MongoServerError"), "missing error name");
      assert.ok(!line.includes("shh-s3cret"), "startup log leaked secret");
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = original;
      process.exitCode = previousExitCode;
    }
  });
});
