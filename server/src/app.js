const cors = require("cors");
const express = require("express");
const helmet = require("helmet");

const { getEnv } = require("./config/env");
const connectDB = require("./config/db");
const AppError = require("./utils/AppError");
const { HTTP_STATUS } = require("./constants/httpStatus");
const asyncHandler = require("./utils/asyncHandler");
const errorHandler = require("./middleware/errorHandler");
const notFound = require("./middleware/notFound");
const requestId = require("./middleware/requestId");
const securityHeaders = require("./middleware/securityHeaders");
const meetingsRoutes = require("./routes/meetings");
const meetingLinksRoutes = require("./routes/meetingLinks");
const webhooksRoutes = require("./routes/webhooks");
const devLabRoutes = require("./routes/devLab");
const authRoutes = require("./routes/auth");

const app = express();
const { clientUrl, nodeEnv } = getEnv();

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
app.use(helmet());
app.use(securityHeaders);
app.use(cors(clientUrl ? { origin: corsOrigin, credentials: true } : undefined));
// Minimal cookie reader (no new dependency): parses Cookie header
// into req.cookies for the HttpOnly auth transport. Values are never
// logged.
app.use((req, _res, next) => {
  req.cookies = {};
  try {
    const header = req.headers && req.headers.cookie;
    if (typeof header === "string" && header.length > 0) {
      for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) {
          continue;
        }
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name && value && !(name in req.cookies)) {
          try {
            req.cookies[name] = decodeURIComponent(value);
          } catch (_unused) {
            req.cookies[name] = value;
          }
        }
      }
    }
  } catch (_unused) {
    req.cookies = {};
  }
  next();
});
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ limit: "100kb", extended: false }));

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    res.status(200).json({ status: "ok" });
  })
);

// The regular Node server connects before listening. Vercel imports this
// Express app directly, so establish one shared connection on the first API
// request instead of letting Mongoose buffer User queries for 10 seconds.
const requireDatabase = asyncHandler(async (_req, _res, next) => {
  try {
    await connectDB();
    next();
  } catch (_unused) {
    next(
      new AppError(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "Database temporarily unavailable. Please retry shortly.",
        "DATABASE_UNAVAILABLE"
      )
    );
  }
});

app.use("/api/meetings", requireDatabase, meetingsRoutes);
app.use("/api/meeting-links", requireDatabase, meetingLinksRoutes);
app.use("/api/auth", requireDatabase, authRoutes);
// Provider webhooks verify by signature over raw bytes (route-scoped
// raw parser inside the router) — never user JWT/CSRF auth.
app.use("/api/webhooks", requireDatabase, webhooksRoutes);
// The contract lab is useful in development/test, but must not exist on the
// production route surface even behind authentication.
if (nodeEnv !== "production") {
  app.use("/dev", requireDatabase, devLabRoutes);
}

app.use(notFound);
app.use(errorHandler);

module.exports = app;
