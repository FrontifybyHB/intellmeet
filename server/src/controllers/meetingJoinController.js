"use strict";

const { HTTP_STATUS } = require("../constants/httpStatus");
const asyncHandler = require("../utils/asyncHandler");
const { observeJoin } = require("../utils/joinMetrics");
const { authorizeJoin } = require("../services/meetingJoinService");

// Thin controller: auth and membership are enforced server-side in the
// service. Any client-supplied role/body fields are ignored.
const joinMeeting = asyncHandler(async (req, res) => {
  const started = process.hrtime.bigint();
  let outcome = "INTERNAL_ERROR";
  try {
    const result = await authorizeJoin({
      meetingIdParam: req.params.id,
      userId: req.user.id,
    });
    outcome = "OK";
    // Token responses must never be stored by browsers or proxies: each
    // join mints a fresh short-lived token and signed tokens are never
    // reused or cached across joins.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.status(HTTP_STATUS.OK).json(result);
  } catch (err) {
    if (err && typeof err.code === "string" && err.code.length > 0) {
      outcome = err.code;
    }
    throw err;
  } finally {
    observeJoin(Number(process.hrtime.bigint() - started) / 1e6, outcome);
  }
});

module.exports = { joinMeeting };
