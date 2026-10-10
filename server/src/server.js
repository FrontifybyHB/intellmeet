require("dotenv").config();

const app = require("./app");
const connectDB = require("./config/db");

const port = Number(process.env.PORT) || 5000;

async function startServer() {
  await connectDB();

  app.listen(port, () => {
    console.log(`IntellMeet API listening on port ${port}.`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start the IntellMeet API:", error);
  process.exitCode = 1;
});
