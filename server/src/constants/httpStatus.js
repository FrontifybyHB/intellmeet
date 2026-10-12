"use strict";

// Minimal HTTP status constants used by boot middleware now.
// Extend only when a new middleware/route actually uses the code.
const HTTP_STATUS = {
  OK: 200,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
};

module.exports = { HTTP_STATUS };
