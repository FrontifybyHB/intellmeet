"use strict";

const { randomUUID } = require("node:crypto");

const REQUEST_ID_HEADER = "x-request-id";
const MAX_INCOMING_ID_LENGTH = 64;
const INCOMING_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function requestId(req, res, next) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const useIncoming =
    typeof incoming === "string" &&
    incoming.length > 0 &&
    incoming.length <= MAX_INCOMING_ID_LENGTH &&
    INCOMING_ID_PATTERN.test(incoming);

  req.id = useIncoming ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

module.exports = requestId;
module.exports.REQUEST_ID_HEADER = REQUEST_ID_HEADER;
