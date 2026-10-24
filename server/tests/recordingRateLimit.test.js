"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const recordingRateLimit = require("../src/middleware/recordingRateLimit");

afterEach(() => recordingRateLimit.resetForTests());

test("recording control is bounded per user and meeting", () => {
  const req = { user: { id: "user-1" }, params: { id: "meeting-1" } };
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  for (let i = 0; i < 20; i += 1) {
    let called = false;
    recordingRateLimit(req, res, (err) => {
      assert.equal(err, undefined);
      called = true;
    });
    assert.equal(called, true);
  }
  let rejected;
  recordingRateLimit(req, res, (err) => { rejected = err; });
  assert.equal(rejected.code, "RATE_LIMITED");
  assert.ok(Number(res.headers["Retry-After"]) >= 1);
});
