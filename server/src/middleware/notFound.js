"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");

const MAX_PATH_LENGTH = 200;

// Query strings can carry tokens/secrets, so only the pathname is ever
// echoed. req.path already excludes the query; the split fallback covers
// unit-test doubles and non-Express callers.
function safePath(req) {
  if (req && typeof req.path === "string" && req.path) {
    return req.path;
  }
  const raw = (req && (req.originalUrl || req.url)) || "";
  return raw.split("?")[0] || "unknown path";
}

function notFound(req, _res, next) {
  const pathname = safePath(req);
  const path =
    pathname.length > MAX_PATH_LENGTH
      ? `${pathname.slice(0, MAX_PATH_LENGTH)}…`
      : pathname;
  next(
    new AppError(
      HTTP_STATUS.NOT_FOUND,
      `No route matches ${req.method} ${path}.`,
      "NOT_FOUND"
    )
  );
}

module.exports = notFound;
