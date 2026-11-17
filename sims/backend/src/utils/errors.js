'use strict';

/** Operational error with an HTTP status and a stable machine-readable code. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (code = 'UNAUTHORIZED', message = 'Authentication required') => new AppError(401, code, message);
const forbidden = (message = 'You do not have access to this resource', code = 'FORBIDDEN') => new AppError(403, code, message);
// 404 (not 403) when an id is outside the caller's scope, so existence is never leaked.
const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (code, message) => new AppError(409, code, message);

/** Wrap an async route handler so rejections reach the error middleware (Express 4). */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, asyncHandler };
