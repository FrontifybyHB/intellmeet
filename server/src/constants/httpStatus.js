"use strict";

// Minimal HTTP status constants used by boot middleware now.
// Extend only when a new middleware/route actually uses the code.
const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

module.exports = { HTTP_STATUS };
