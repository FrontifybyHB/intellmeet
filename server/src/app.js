const cors = require("cors");
const express = require("express");

const app = express();
const clientUrl = process.env.CLIENT_URL;

app.use(cors(clientUrl ? { origin: clientUrl } : undefined));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

module.exports = app;
