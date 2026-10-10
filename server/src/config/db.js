const mongoose = require("mongoose");

async function connectDB() {
  const { MONGODB_URI } = process.env;

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required to connect to the database.");
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB.");
}

module.exports = connectDB;
