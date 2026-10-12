"use strict";

// Minimal boot logger. Structured single-line output, no secret values.
// Callers must pass only redacted fields; this module never reads process.env.
function info(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

function error(event, fields) {
  console.error(JSON.stringify({ event, ...fields }));
}

// Stable, redacted fields for a boot failure. Connection/provider errors are
// outside this code's control, so error.message is never logged — only the
// stable code and the error class name.
function formatStartupFailure(err) {
  const name =
    err && typeof err.name === "string" && err.name ? err.name : "Error";
  return { code: "SERVER_START_FAILED", name };
}

module.exports = { info, error, formatStartupFailure };
