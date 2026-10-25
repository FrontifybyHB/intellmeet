"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const logger = require("../config/logger");

// Safe Express error handler used at the end of the middleware chain.
// - Operational errors (AppError) return their status/message.
// - Unknown 500s return a generic message unless NODE_ENV is explicitly
//   "development" (fail closed: an unset NODE_ENV never exposes internals).
// - Logs structured fields only; never logs secrets, tokens, bodies, or
//   query strings.
// Query strings can carry tokens/secrets, so logs only record the pathname.
// req.path already excludes the query; the split fallback covers unit-test
// doubles and non-Express callers.
function safePath(req) {
  if (req && typeof req.path === "string" && req.path) {
    return req.path;
  }
  const raw = (req && (req.originalUrl || req.url)) || "";
  return raw.split("?")[0] || "unknown path";
}

function errorHandler(err, req, res, _next) {
  const showDetail = process.env.NODE_ENV === "development";
  let status =
    err && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let code =
    err && typeof err.code === "string" && err.code.length > 0
      ? err.code
      : "INTERNAL_ERROR";
  // Convert database-originated client mistakes to the same public contract
  // as explicitly validated input. This prevents malformed data or a race on
  // a unique index from becoming a misleading production 500.
  if (err && err.code === 11000) {
    status = HTTP_STATUS.CONFLICT;
    code = "DUPLICATE_RESOURCE";
  } else if (
    err &&
    (err.name === "ValidationError" || err.name === "CastError") &&
    status === HTTP_STATUS.INTERNAL_SERVER_ERROR
  ) {
    status = HTTP_STATUS.BAD_REQUEST;
    code = "VALIDATION_ERROR";
  }
  if (code === "INTERNAL_ERROR" && err && err.type === "entity.too.large") {
    code = "PAYLOAD_TOO_LARGE";
  } else if (
    code === "INTERNAL_ERROR" &&
    err instanceof SyntaxError &&
    status !== HTTP_STATUS.INTERNAL_SERVER_ERROR
  ) {
    code = "INVALID_BODY";
  }
  let message =
    status === HTTP_STATUS.INTERNAL_SERVER_ERROR && !showDetail
      ? "Internal server error."
      : (err && err.message) || "Internal server error.";
  if (err && err.code === 11000) {
    message = "A resource with those values already exists.";
  } else if (err && (err.name === "ValidationError" || err.name === "CastError")) {
    message = "Invalid request data.";
  }

  logger.error("request_error", {
    requestId: req && req.id ? req.id : undefined,
    method: req && req.method ? req.method : undefined,
    path: safePath(req),
    status,
    code,
  });

  if (res.headersSent) {
    return;
  }
  res.status(status).json({
    status,
    error: {
      message,
      code,
      requestId: req && req.id ? req.id : undefined,
    },
  });
}

module.exports = errorHandler;
