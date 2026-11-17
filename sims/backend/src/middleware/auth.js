'use strict';
const { pool } = require('../db/pool');
const { verifyAccessToken } = require('../utils/tokens');
const { asyncHandler, unauthorized } = require('../utils/errors');
const { loadScope } = require('./scope');

/**
 * Verifies the Bearer access token, then re-reads the user from the DB so that a
 * disabled account loses access immediately instead of when the token expires.
 * Sets req.user = { id, role, email, fullName }.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) throw unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token');
  }

  const { rows } = await pool.query(
    'SELECT id, role, email, full_name, is_active FROM users WHERE id = $1', [payload.sub]);
  const user = rows[0];
  if (!user || !user.is_active) throw unauthorized('INVALID_TOKEN', 'Account not available');

  // The role comes from the DB, not the token, so a role change takes effect at once.
  req.user = { id: user.id, role: user.role, email: user.email, fullName: user.full_name };
  next();
});

/** Standard guard for every protected route: authenticate, then resolve data scope. */
const protect = [authenticate, loadScope];

module.exports = { authenticate, protect };
