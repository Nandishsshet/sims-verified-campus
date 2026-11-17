'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const ISSUER = 'sims';

/** Short-lived access token. Carries only identity + role; scope is always re-read from the DB. */
function signAccessToken(user) {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: env.ACCESS_TOKEN_TTL,
    algorithm: 'HS256',
    issuer: ISSUER,
  });
}

/** @throws jwt errors (TokenExpiredError, JsonWebTokenError) */
function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
}

/** Opaque random token for refresh / password-reset. Only its hash is stored. */
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

module.exports = { signAccessToken, verifyAccessToken, randomToken, sha256 };
