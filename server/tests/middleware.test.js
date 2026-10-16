"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/intellmeet";
process.env.NODE_ENV = "test";
process.env.CLIENT_URL =
  process.env.CLIENT_URL || "http://localhost:5173";

const app = require("../src/app");

let server;
let baseUrl;

function request(path, options) {
  return fetch(`${baseUrl}${path}`, options);
}

describe("middleware behavior", () => {
  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("preserves GET /api/health contract", async () => {
    const res = await request("/api/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
    assert.ok(res.headers.get("x-request-id"), "missing X-Request-Id header");
  });

  it("returns safe JSON 404 for unknown routes", async () => {
    const res = await request("/api/does-not-exist");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.requestId, "404 body should carry requestId");
  });

  it("echoes a valid incoming X-Request-Id", async () => {
    const res = await request("/api/health", {
      headers: { "x-request-id": "test-id_123-ABC" },
    });
    assert.equal(res.headers.get("x-request-id"), "test-id_123-ABC");
    const body = await res.json();
    assert.deepEqual(body, { status: "ok" });
  });

  it("sets baseline security headers and hides X-Powered-By", async () => {
    const res = await request("/api/health");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("error log output never contains secret values", async () => {
    const logs = [];
    const original = console.error;
    console.error = (line) => logs.push(String(line));
    try {
      const errorHandler = require("../src/middleware/errorHandler");
      const req = { id: "req-2", method: "GET", originalUrl: "/y" };
      const res = {
        headersSent: false,
        status() {
          return this;
        },
        json() {},
      };
      errorHandler(
        new Error("livekit-secret s3cret-value"),
        req,
        res,
        () => {}
      );
    } finally {
      console.error = original;
    }
    assert.ok(logs.length > 0, "expected an error log line");
    assert.ok(
      !logs.join("\n").includes("s3cret-value"),
      "error log leaked secret"
    );
  });
  it("hides internal error details in production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const errorHandler = require("../src/middleware/errorHandler");
      const req = { id: "req-1", method: "GET", originalUrl: "/x" };
      let status;
      let payload;
      const res = {
        headersSent: false,
        status(code) {
          status = code;
          return this;
        },
        json(body) {
          payload = body;
        },
      };
      errorHandler(new Error("mongodb://secret-uri-leak"), req, res, () => {});
      assert.equal(status, 500);
      assert.equal(payload.error.message, "Internal server error.");
      assert.ok(
        !JSON.stringify(payload).includes("secret-uri-leak"),
        "error body leaked internals"
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("hides 500 details when NODE_ENV is unset", async () => {
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const errorHandler = require("../src/middleware/errorHandler");
      const req = { id: "req-unset", method: "GET", path: "/x" };
      let status;
      let payload;
      const res = {
        headersSent: false,
        status(code) {
          status = code;
          return this;
        },
        json(body) {
          payload = body;
        },
      };
      errorHandler(new Error("mongodb://unset-env-leak"), req, res, () => {});
      assert.equal(status, 500);
      assert.equal(payload.error.message, "Internal server error.");
      assert.ok(
        !JSON.stringify(payload).includes("unset-env-leak"),
        "error body leaked internals with NODE_ENV unset"
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("keeps query-string secrets out of 404 responses and logs", async () => {
    const logs = [];
    const original = console.error;
    console.error = (line) => logs.push(String(line));
    try {
      const res = await request("/api/does-not-exist?token=review-secret");
      const text = await res.text();
      assert.equal(res.status, 404);
      assert.ok(
        !text.includes("review-secret"),
        "404 response leaked query secret"
      );
      assert.ok(
        !logs.join("\n").includes("review-secret"),
        "404 log leaked query secret"
      );
    } finally {
      console.error = original;
    }
  });

  it("rejects a disallowed Origin with the safe error envelope", async () => {
    const denied = await request("/api/health", {
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(denied.status, 403);
    const body = await denied.json();
    assert.equal(body.error.code, "FORBIDDEN");
    assert.equal(body.error.message, "Origin not allowed.");
    assert.ok(body.error.requestId, "403 body should carry requestId");

    const allowed = await request("/api/health", {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "http://localhost:5173"
    );
  });

  it("rejects oversized JSON with the safe error envelope", async () => {
    const big = JSON.stringify({ data: "a".repeat(200 * 1024) });
    const res = await request("/api/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    const text = await res.text();
    assert.equal(res.status, 413);
    const body = JSON.parse(text);
    assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
    assert.ok(body.error.requestId, "413 body should carry requestId");
    assert.ok(
      !text.includes("a".repeat(1000)),
      "413 response echoed request body"
    );
  });

  it("rejects oversized urlencoded bodies with the safe error envelope", async () => {
    const big = `x=${"b".repeat(200 * 1024)}`;
    const res = await request("/api/health", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: big,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
    assert.ok(body.error.requestId, "413 body should carry requestId");
  });

  it("rejects malformed JSON with the safe error envelope", async () => {
    const res = await request("/api/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-valid-json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_BODY");
    assert.ok(body.error.requestId, "400 body should carry requestId");
  });
});
