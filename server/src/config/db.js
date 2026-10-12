const mongoose = require("mongoose");

const { getEnv } = require("./env");
const logger = require("./logger");

async function connectDB() {
  const { mongoUri } = getEnv();

  await mongoose.connect(mongoUri);
  logger.info("db_connected", {});
}

module.exports = connectDB;
