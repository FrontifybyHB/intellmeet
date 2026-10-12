const { getEnv, getSafeEnvSummary } = require("./config/env");
const logger = require("./config/logger");

const app = require("./app");
const connectDB = require("./config/db");

const { port, nodeEnv } = getEnv();

async function startServer() {
  await connectDB();

  app.listen(port, () => {
    logger.info("server_listening", { ...getSafeEnvSummary(), env: nodeEnv });
  });
}

function handleStartupError(error) {
  logger.error("server_start_failed", logger.formatStartupFailure(error));
  process.exitCode = 1;
}

if (require.main === module) {
  startServer().catch(handleStartupError);
}

module.exports = { startServer, handleStartupError };
