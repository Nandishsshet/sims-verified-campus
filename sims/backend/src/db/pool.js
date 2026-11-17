'use strict';
const { Pool, types } = require('pg');
const env = require('../config/env');

// A calendar DATE (date of birth, attendance day, issue date…) has no time zone. node-postgres would turn it into
// a Date at *local* midnight, which serialises one day early in UTC+ zones (e.g. India). Keep it as 'YYYY-MM-DD'.
types.setTypeParser(types.builtins.DATE, (v) => v);

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

// An idle-client error must not crash the process.
pool.on('error', (err) => console.error('[pg] idle client error', err.message));

/**
 * Run `fn(client)` inside a transaction. Commits on success, rolls back on any throw.
 * Keep transactions short: do slow work (bcrypt, network) BEFORE calling this.
 */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, tx, end: () => pool.end() };
