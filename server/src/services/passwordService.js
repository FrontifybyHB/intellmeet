"use strict";

const argon2 = require("argon2");
const bcrypt = require("bcryptjs");

const { AUTH_LIMITS } = require("../constants/authLimits");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");

// Argon2id for all new hashes: m=19456 KiB, t=2, p=1 (OWASP minimum;
// measured ~40ms hash/verify on the dev machine; m=65536,t=3 measured
// ~190ms and was rejected as default to protect login latency —
// documented, not silently weakened). Concurrency stays bounded:
// argon2 is intentionally expensive, so at most HASH_CONCURRENCY_MAX
// hash/verify operations run at once; overflow fails closed with 503
// OVERLOADED rather than exhausting threads/RAM.
const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

// Bounded local common-password blocklist (no external dependency).
const COMMON_PASSWORDS = new Set(
  [
    "password",
    "password1",
    "password123",
    "password123!",
    "password1234",
    "123456",
    "12345678",
    "123456789",
    "qwerty",
    "qwerty123",
    "letmein",
    "welcome",
    "welcome123",
    "admin123",
    "iloveyou",
    "monkey123",
    "dragon123",
    "football123",
    "abc123456",
    "123123123",
    "passw0rd",
    "changeme",
    "Test123456789!",
    "P@ssw0rd123456",
  ].map((s) => s.toLowerCase())
);

let inflight = 0;

async function withSlot(fn) {
  if (inflight >= AUTH_LIMITS.HASH_CONCURRENCY_MAX) {
    throw new AppError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Authentication is busy. Please retry shortly.",
      "OVERLOADED"
    );
  }
  inflight += 1;
  try {
    return await fn();
  } finally {
    inflight -= 1;
  }
}

// New-password policy: 15-128 Unicode chars + 512 UTF-8 byte ceiling.
// No trim/lowercase/transform, no composition rules, spaces allowed.
// Legacy shorter passwords still verify at login.
function validateNewPassword(password) {
  if (typeof password !== "string") {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Password must be a string.",
      "VALIDATION_ERROR"
    );
  }
  const chars = Array.from(password).length;
  if (
    chars < AUTH_LIMITS.PASSWORD_MIN_CHARS ||
    chars > AUTH_LIMITS.PASSWORD_MAX_CHARS
  ) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      `Password must be ${AUTH_LIMITS.PASSWORD_MIN_CHARS}-${AUTH_LIMITS.PASSWORD_MAX_CHARS} characters.`,
      "WEAK_PASSWORD"
    );
  }
  if (Buffer.byteLength(password, "utf8") > AUTH_LIMITS.PASSWORD_MAX_BYTES) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Password is too long.",
      "WEAK_PASSWORD"
    );
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Password is too common.",
      "WEAK_PASSWORD"
    );
  }
}

function hashFormat(stored) {
  if (typeof stored !== "string" || stored.length === 0) {
    return "unknown";
  }
  if (stored.startsWith("$argon2id$")) {
    return "argon2";
  }
  if (
    stored.startsWith("$2a$") ||
    stored.startsWith("$2b$") ||
    stored.startsWith("$2y$")
  ) {
    return "bcrypt";
  }
  if (stored.startsWith("scrypt$")) {
    return "scrypt";
  }
  return "unknown";
}

async function hashPassword(password) {
  validateNewPassword(password);
  return withSlot(async () => argon2.hash(password, ARGON_OPTS));
}

// Verification across formats (no silent truncation, no improvised
// prehashing — each format uses its own vetted verifier):
//   argon2  current format
//   bcrypt  legacy compat ($2a$/$2b$ via bcryptjs; $2y$ treated as $2b$)
//   scrypt  previous-iteration compat (repo's own scrypt$ envelope)
// Returns { ok, needsRehash } so callers can conditionally upgrade the
// stored hash after a successful authentication (never double-hash).
async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") {
    return { ok: false, needsRehash: false };
  }
  const format = hashFormat(stored);
  if (format === "argon2") {
    const ok = await withSlot(async () => {
      try {
        return await argon2.verify(stored, password);
      } catch (_unused) {
        return false;
      }
    });
    return { ok, needsRehash: false };
  }
  if (format === "bcrypt") {
    const normalized =
      stored.startsWith("$2y$") ? `$2b$${stored.slice(4)}` : stored;
    const ok = await withSlot(async () => {
      try {
        return await bcrypt.compare(password, normalized);
      } catch (_unused) {
        return false;
      }
    });
    return { ok, needsRehash: ok };
  }
  if (format === "scrypt") {
    const ok = await verifyScryptLegacy(password, stored);
    return { ok, needsRehash: ok };
  }
  return { ok: false, needsRehash: false };
}

const { promisify } = require("node:util");
const crypto = require("node:crypto");

const scryptAsync = promisify(crypto.scrypt);

function parseScrypt(stored) {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") {
    return null;
  }
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]);
  if (!m) {
    return null;
  }
  return {
    N: Number(m[1]),
    r: Number(m[2]),
    p: Number(m[3]),
    salt: parts[2],
    key: parts[3],
  };
}

async function verifyScryptLegacy(password, stored) {
  const parsed = parseScrypt(stored);
  if (!parsed) {
    return false;
  }
  return withSlot(async () => {
    try {
      const salt = Buffer.from(parsed.salt, "base64");
      const expected = Buffer.from(parsed.key, "base64");
      if (salt.length === 0 || expected.length === 0) {
        return false;
      }
      const actual = await scryptAsync(password, salt, expected.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: 128 * 1024 * 1024,
      });
      if (actual.length !== expected.length) {
        return false;
      }
      return crypto.timingSafeEqual(actual, expected);
    } catch (_unused) {
      return false;
    }
  });
}

// Fixed valid dummy hash so missing-user logins cost the same Argon2id
// work as real verifications (rate limiting remains the brute-force
// defense; no timing guarantee is claimed).
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) {
    dummyHash = await argon2.hash(crypto.randomBytes(16).toString("hex"), ARGON_OPTS);
  }
  try {
    await argon2.verify(dummyHash, typeof password === "string" ? password : "x");
  } catch (_unused) {
    // Dummy result is always discarded; cost is the point.
  }
}

function inflightForTests() {
  return inflight;
}

module.exports = {
  hashPassword,
  verifyPassword,
  dummyVerify,
  validateNewPassword,
  hashFormat,
  inflightForTests,
};
