"use strict";

// Minimal security headers without extra dependencies.
// Helmet is intentionally not added in Phase 0 (no new packages);
// revisit when a header policy beyond this baseline is required.
function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.removeHeader("X-Powered-By");
  next();
}

module.exports = securityHeaders;
