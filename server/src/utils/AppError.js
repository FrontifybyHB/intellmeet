"use strict";

class AppError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code || "INTERNAL_ERROR";
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
