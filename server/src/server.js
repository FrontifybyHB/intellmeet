const http = require("node:http");

const { getEnv, getSafeEnvSummary } = require("./config/env");
const logger = require("./config/logger");

const app = require("./app");
const connectDB = require("./config/db");
const { attachMeetingSockets } = require("./sockets/meetingSockets");

const { port, nodeEnv } = getEnv();

// Graceful-shutdown drain budget: in-flight chat sends finish persisting
// inside this window before the process exits.
const SHUTDOWN_GRACE_MS = 5000;

let server = null;
let sockets = null;
let shuttingDown = false;
let recordingRecoveryScheduler = null;

async function startServer() {
  await connectDB();

  // One HTTP server for Express + Socket.IO: the socket server attaches
  // to this listener instead of opening its own port.
  server = http.createServer(app);
  sockets = attachMeetingSockets(server);
  // Recording has no BullMQ worker. Lease-claimed recovery runs with the
  // API so partial provider outcomes recover even if AI is disabled.
  const { startRecoveryScheduler } = require("./queues/recoveryScheduler");
  const { recoverStuck } = require("./services/recordingRecovery");
  recordingRecoveryScheduler = startRecoveryScheduler({
    name: "recording",
    recover: () => recoverStuck({}),
  });

  await new Promise((resolve) => {
    server.listen(port, resolve);
  });
  console.log("server_listening 3000")
  logger.info("server_listening", { ...getSafeEnvSummary(), env: nodeEnv });
  return { server, sockets };
}

async function stopServer() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const grace = new Promise((resolve) => {
    setTimeout(resolve, SHUTDOWN_GRACE_MS);
  });
  try {
    if (recordingRecoveryScheduler) {
      recordingRecoveryScheduler.stop();
      recordingRecoveryScheduler = null;
    }
    // Disconnect sockets first so clients fail over to history catch-up,
    // then stop accepting HTTP. No timers/listeners leak: the socket
    // module holds no per-connection intervals.
    if (sockets) {
      await sockets.close();
    }
    // socket.io 4.x closes the attached HTTP server as part of io.close():
    // only close it when still listening.
    if (server && server.listening) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    await grace;
  }
  logger.info("server_stopped", {});
}

function handleStartupError(error) {
  logger.error("server_start_failed", logger.formatStartupFailure(error));
  process.exitCode = 1;
}

function handleShutdownSignal(signal) {
  logger.info("shutdown_signal", { signal });
  stopServer()
    .then(() => {
      server = null;
      sockets = null;
    })
    .catch((err) => {
      logger.error(
        "server_stop_failed",
        logger.formatStartupFailure(err)
      );
    });
}

if (require.main === module) {
  startServer().catch(handleStartupError);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => handleShutdownSignal(signal));
  }
}

module.exports = { startServer, stopServer, handleStartupError };
module.exports.SHUTDOWN_GRACE_MS = SHUTDOWN_GRACE_MS;
