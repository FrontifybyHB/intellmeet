"use strict";

const mongoose = require("mongoose");

const { getEnv } = require("./env");
const logger = require("./logger");

let connecting = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  if (connecting) {
    return connecting;
  }
  const {
    mongoUri,
    mongoMaxPoolSize,
    mongoServerSelectionTimeoutMs,
    mongoSocketTimeoutMs,
  } = getEnv();

  // Reuses the process-level Mongoose client; never creates clients per
  // request. Pool and timeouts stay small and bounded for the measured
  // join workload (a few sequential reads per request). A selection
  // timeout rejects the awaiting request while the driver cleans up its
  // own attempt — no unlimited background work is left running. Raise
  // MONGO_MAX_POOL_SIZE only with measured connection-queue pressure and
  // only within total-replica limits.
  connecting = mongoose
    .connect(mongoUri, {
      maxPoolSize: mongoMaxPoolSize,
      serverSelectionTimeoutMS: mongoServerSelectionTimeoutMs,
      socketTimeoutMS: mongoSocketTimeoutMs,
    })
    .then(() => {
      logger.info("db_connected", {});
      return mongoose.connection;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

module.exports = connectDB;
