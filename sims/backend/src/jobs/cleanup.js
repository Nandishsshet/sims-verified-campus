'use strict';
/**
 * Housekeeping: rows that can never be used again would otherwise pile up for ever.
 *  · refresh tokens past their expiry (a *revoked but unexpired* token is kept — it is what detects token reuse)
 *  · password-reset tokens past their expiry
 * Runs once at start-up and then every few hours. Safe to run from several instances at once (plain DELETEs).
 */
const { pool } = require('../db/pool');

const EVERY_MS = 6 * 60 * 60 * 1000;

async function runCleanup(db = pool) {
  const [rt, pr] = await Promise.all([
    db.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'`),
    db.query(`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'`),
  ]);
  return { refreshTokens: rt.rowCount, passwordResets: pr.rowCount };
}

/** Start the periodic job. Failures are logged, never thrown; the timer does not keep the process alive. */
function startCleanup(log = console) {
  const tick = () => runCleanup().then((r) => { if (r.refreshTokens || r.passwordResets) log.log(`[cleanup] removed ${r.refreshTokens} expired refresh tokens, ${r.passwordResets} reset tokens`); })
    .catch((e) => log.error('[cleanup] failed:', e.message));
  tick();
  return setInterval(tick, EVERY_MS).unref();
}

module.exports = { runCleanup, startCleanup };
