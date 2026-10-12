const cors = require("cors");
const express = require("express");

const { getEnv } = require("./config/env");
const AppError = require("./utils/AppError");
const asyncHandler = require("./utils/asyncHandler");
const errorHandler = require("./middleware/errorHandler");
const notFound = require("./middleware/notFound");
const requestId = require("./middleware/requestId");
const securityHeaders = require("./middleware/securityHeaders");

const app = express();
const { clientUrl } = getEnv();

// Non-browser requests carry no Origin and always pass. Browser requests
// must match CLIENT_URL; anything else fails closed with a safe 403
// envelope instead of silently echoing access headers.
function corsOrigin(origin, callback) {
  if (!origin || (clientUrl && origin === clientUrl)) {
    callback(null, true);
    return;
  }
  callback(new AppError(403, "Origin not allowed.", "FORBIDDEN"), false);
}

app.use(requestId);
app.use(securityHeaders);
app.use(cors(clientUrl ? { origin: corsOrigin } : undefined));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ limit: "100kb", extended: false }));

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    res.status(200).json({ status: "ok" });
  })
);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
