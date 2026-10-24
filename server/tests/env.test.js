"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { loadEnv, getSafeEnvSummary } = require("../src/config/env");

const VALID = {
  NODE_ENV: "test",
  PORT: "5000",
  CLIENT_URL: "http://localhost:5173",
  MONGODB_URI: "mongodb://127.0.0.1:27017/intellmeet",
};

describe("config/env validation", () => {
  it("throws when MONGODB_URI is missing", () => {
    const { MONGODB_URI, ...rest } = VALID;
    assert.throws(() => loadEnv(rest), /MONGODB_URI is required/);
  });

  it("throws on invalid PORT values", () => {
    for (const bad of ["abc", "0", "70000", "-1", "12.5"]) {
      assert.throws(
        () => loadEnv({ ...VALID, PORT: bad }),
        /PORT must be an integer/,
        `expected PORT=${bad} to throw`
      );
    }
  });

  it("throws on invalid CLIENT_URL values", () => {
    for (const bad of ["not-a-url", "ftp://example.com/x", "localhost:5173"]) {
      assert.throws(
        () => loadEnv({ ...VALID, CLIENT_URL: bad }),
        /CLIENT_URL must be a valid http\(s\) URL/,
        `expected CLIENT_URL=${bad} to throw`
      );
    }
  });

  it("requires CLIENT_URL in production", () => {
    const { CLIENT_URL, ...rest } = VALID;
    assert.throws(
      () => loadEnv({ ...rest, NODE_ENV: "production" }),
      /CLIENT_URL is required in production/
    );
  });

  it("requires JWT_SECRET in production", () => {
    assert.throws(
      () => loadEnv({ ...VALID, NODE_ENV: "production" }),
      /JWT_SECRET is required in production/
    );
  });

  it("allows missing CLIENT_URL outside production", () => {
    const { CLIENT_URL, ...rest } = VALID;
    const env = loadEnv({ ...rest, NODE_ENV: "development" });
    assert.equal(env.clientUrl, undefined);
  });
  it("throws on invalid NODE_ENV values", () => {
    assert.throws(
      () => loadEnv({ ...VALID, NODE_ENV: "staging" }),
      /NODE_ENV must be one of/
    );
  });

  it("applies defaults for PORT and NODE_ENV", () => {
    const env = loadEnv({ MONGODB_URI: VALID.MONGODB_URI });
    assert.equal(env.port, 3000);
    assert.equal(env.nodeEnv, "development");
    assert.equal(env.clientUrl, undefined);
  });

  it("redacted summary never contains secret values", () => {
    const secretUri = "mongodb://user:s3cret@db.example.com:27017/intellmeet";
    const env = loadEnv({ ...VALID, MONGODB_URI: secretUri });
    const summary = getSafeEnvSummary(env);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("s3cret"), "summary leaked secret");
    assert.ok(!serialized.includes(secretUri), "summary leaked full URI");
    assert.equal(summary.mongoConfigured, true);
    assert.equal(summary.clientUrlConfigured, true);
  });

  it("normalizes a complete B2 group and reports real storage readiness", () => {
    const env = loadEnv({
      ...VALID,
      B2_ACCESS_KEY_ID: "key-id",
      B2_SECRET_ACCESS_KEY: "secret-value",
      B2_BUCKET_NAME: "private-recordings",
      B2_REGION: "us-west-004",
      B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    });
    assert.equal(env.recordingStorageAccessKey, "key-id");
    assert.equal(env.recordingOutputBucket, "private-recordings");
    assert.equal(env.recordingStorageConfigured, true);
  });

  it("rejects partial, mixed, and untrusted B2 storage configuration", () => {
    assert.throws(
      () => loadEnv({ ...VALID, B2_BUCKET_NAME: "private-recordings" }),
      /B2 recording storage configuration must be complete/
    );
    assert.throws(
      () => loadEnv({
        ...VALID,
        B2_ACCESS_KEY_ID: "a",
        B2_SECRET_ACCESS_KEY: "b",
        B2_BUCKET_NAME: "c",
        B2_REGION: "us-west-004",
        B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
        RECORDING_OUTPUT_BUCKET: "legacy",
      }),
      /cannot be mixed/
    );
    assert.throws(
      () => loadEnv({
        ...VALID,
        B2_ACCESS_KEY_ID: "a",
        B2_SECRET_ACCESS_KEY: "b",
        B2_BUCKET_NAME: "c",
        B2_REGION: "us-west-004",
        B2_ENDPOINT: "https://example.com",
      }),
      /trusted regional HTTPS B2 S3 endpoint/
    );
  });
});
