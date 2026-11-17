'use strict';
const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const limitReached = (code, message) => (req, res) =>
  res.status(429).json({ error: { code, message } });

const common = { standardHeaders: true, legacyHeaders: false, skip: () => env.NODE_ENV === 'test' };

/** Credential endpoints: 10 requests / minute / IP. */
const authLimiter = rateLimit({
  ...common, windowMs: 60_000, limit: 10,
  handler: limitReached('RATE_LIMITED', 'Too many attempts. Please wait a minute and try again.'),
});

/** Session resume (every page load calls it). It needs a valid refresh cookie, so it is not a credential-guessing
 *  endpoint — it gets its own, looser bucket instead of sharing the 10/min login one (a few reloads used to log people out). */
const refreshLimiter = rateLimit({
  ...common, windowMs: 60_000, limit: 60,
  handler: limitReached('RATE_LIMITED', 'Too many requests. Please wait a minute and try again.'),
});

/** Key-redemption endpoints: 5 attempts / 10 minutes per IP + account. (A persistent,
 *  DB-backed lockout on failed guesses sits behind this — see keys.service.js.) */
const joinLimiter = rateLimit({
  ...common, windowMs: 10 * 60_000, limit: 5,
  keyGenerator: (req) => `${req.ip}|${req.user?.id ?? 'anon'}`,
  handler: limitReached('RATE_LIMITED', 'Too many key attempts. Please wait and try again.'),
});

/** Broad safety net for everything else. */
const apiLimiter = rateLimit({
  ...common, windowMs: 60_000, limit: 300,
  handler: limitReached('RATE_LIMITED', 'Too many requests.'),
});

module.exports = { authLimiter, refreshLimiter, joinLimiter, apiLimiter };
