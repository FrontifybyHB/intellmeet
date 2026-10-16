"use strict";

const crypto = require("node:crypto");

const { getEnv } = require("../config/env");
const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");

function base64UrlDecode(input) {
  return Buffer.from(
    input.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function verifyHs256Jwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token.");
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid signature.");
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (_unused) {
    throw new Error("Invalid payload.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && nowSeconds >= payload.exp) {
    throw new Error("Token expired.");
  }
  return payload;
}

// Existing authentication gate for protected meeting routes.
// Expects `Authorization: Bearer <jwt>` (HS256, sub = user id).
// Never logs the token value.
function requireAuth(req, _res, next) {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    next(new AppError(HTTP_STATUS.UNAUTHORIZED, "Authentication required.", "UNAUTHORIZED"));
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    next(new AppError(HTTP_STATUS.UNAUTHORIZED, "Authentication required.", "UNAUTHORIZED"));
    return;
  }
  let secret;
  try {
    secret = getEnv().jwtSecret;
  } catch (err) {
    next(err);
    return;
  }
  if (!secret) {
    next(
      new AppError(
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        "Authentication is not configured.",
        "AUTH_MISCONFIGURED"
      )
    );
    return;
  }
  let payload;
  try {
    payload = verifyHs256Jwt(token, secret);
  } catch (_unused) {
    next(
      new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid or expired token.", "UNAUTHORIZED")
    );
    return;
  }
  const userId = payload.sub || payload.userId || payload.id;
  if (typeof userId !== "string" || userId.length === 0) {
    next(
      new AppError(HTTP_STATUS.UNAUTHORIZED, "Invalid or expired token.", "UNAUTHORIZED")
    );
    return;
  }
  req.user = { id: userId };
  next();
}

module.exports = requireAuth;
module.exports.verifyHs256Jwt = verifyHs256Jwt;
