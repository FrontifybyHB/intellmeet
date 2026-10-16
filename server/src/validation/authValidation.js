"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const { AUTH_LIMITS } = require("../constants/authLimits");

// Strict auth body validation: types/sizes checked before any hashing
// or query; unknown fields rejected (no req.body spread into models).
const ALLOWED_REGISTER = new Set(["name", "email", "password"]);
const ALLOWED_LOGIN = new Set(["email", "password"]);
const ALLOWED_CHANGE = new Set(["currentPassword", "newPassword"]);

function rejectUnknown(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid request body.",
      "VALIDATION_ERROR"
    );
  }
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new AppError(
        HTTP_STATUS.BAD_REQUEST,
        `Unknown field: ${key}.`,
        "VALIDATION_ERROR"
      );
    }
  }
}

function validateName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Name is required.", "VALIDATION_ERROR");
  }
  if (Array.from(name.trim()).length > AUTH_LIMITS.NAME_MAX_CHARS) {
    throw new AppError(HTTP_STATUS.BAD_REQUEST, "Name is too long.", "VALIDATION_ERROR");
  }
  return name.trim();
}

// Normalize email consistently (trim + lowercase) to match the User
// unique index. No provider-specific dot/plus rewriting.
function validateEmail(email) {
  if (typeof email !== "string") {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Email is required.",
      "VALIDATION_ERROR"
    );
  }
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > AUTH_LIMITS.EMAIL_MAX_CHARS ||
    normalized.length < 3 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Email is invalid.",
      "VALIDATION_ERROR"
    );
  }
  return normalized;
}

function validateRegister(body) {
  rejectUnknown(body, ALLOWED_REGISTER);
  const name = validateName(body.name);
  const email = validateEmail(body.email);
  if (typeof body.password !== "string" || body.password.length === 0) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Password is required.",
      "VALIDATION_ERROR"
    );
  }
  // Password strength checked in passwordService (no transform here —
  // never trim/lowercase passwords).
  return { name, email, password: body.password };
}

function validateLogin(body) {
  rejectUnknown(body, ALLOWED_LOGIN);
  const email = validateEmail(body.email);
  if (typeof body.password !== "string" || body.password.length === 0) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Email and password are required.",
      "VALIDATION_ERROR"
    );
  }
  if (Buffer.byteLength(body.password, "utf8") > 4096) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid credentials.",
      "VALIDATION_ERROR"
    );
  }
  return { email, password: body.password };
}

function validateChangePassword(body) {
  rejectUnknown(body, ALLOWED_CHANGE);
  if (typeof body.currentPassword !== "string" || body.currentPassword.length === 0) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "Current password is required.",
      "VALIDATION_ERROR"
    );
  }
  if (typeof body.newPassword !== "string" || body.newPassword.length === 0) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "New password is required.",
      "VALIDATION_ERROR"
    );
  }
  return { currentPassword: body.currentPassword, newPassword: body.newPassword };
}

module.exports = {
  validateRegister,
  validateLogin,
  validateChangePassword,
  validateEmail,
};
