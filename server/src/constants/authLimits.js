"use strict";

// Centralized auth limits for the stateless cookie-JWT design. No
// server-side session/token store exists: lifetimes are enforced by
// signed exp claims plus the User authVersion check on every use.
const AUTH_LIMITS = {
  // Passwords: 15-128 Unicode chars for new setups, UTF-8 byte ceiling
  // 512. Legacy shorter passwords still verify at login.
  PASSWORD_MIN_CHARS: 15,
  PASSWORD_MAX_CHARS: 128,
  PASSWORD_MAX_BYTES: 512,
  // Argon2id (m=19456 KiB,t=2,p=1) measured ~40ms on the dev machine.
  // Max 4 concurrent hash/verify ops; overflow fails closed with 503.
  HASH_CONCURRENCY_MAX: 4,
  // Tokens: short access bound by the remaining absolute login
  // lifetime; refresh/login absolute maximum 7 days from password
  // login. Refresh never extends the deadline; expiry needs a fresh
  // password login. No infinite rolling renewal.
  ACCESS_TTL_SECONDS: 600,
  REFRESH_TTL_SECONDS: 7 * 24 * 3600,
  // Names/sizes.
  NAME_MAX_CHARS: 100,
  EMAIL_MAX_CHARS: 254,
  // Cookie names (Secure only in production https; see controller).
  ACCESS_COOKIE: "im_at",
  REFRESH_COOKIE: "im_rt",
  CSRF_COOKIE: "im_csrf",
  CSRF_HEADER: "x-csrf-token",
  // Rate limits (fixed-window, per bucket, per process).
  REGISTER_PER_IP_MAX: 10,
  LOGIN_PER_IP_MAX: 30,
  LOGIN_PER_EMAIL_MAX: 20,
  REFRESH_PER_SESSION_MAX: 60,
  PASSWORD_CHANGE_MAX: 10,
  AUTH_WINDOW_MS: 60000,
};

module.exports = { AUTH_LIMITS };
