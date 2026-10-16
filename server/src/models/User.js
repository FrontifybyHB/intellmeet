"use strict";

const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      index: true,
    },
    passwordHash: { type: String },
    // Server-controlled only: registration always creates role "user"
    // + status "active". Never settable from req.body.
    role: { type: String, enum: ["user", "admin"], default: "user" },
    status: {
      type: String,
      enum: ["active", "disabled"],
      default: "active",
      index: true,
    },
    // Credential version: bumped on password change / logout-all so
    // previously issued access JWTs fail closed at requireAuth.
    authVersion: { type: Number, default: 0 },
    passwordUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
