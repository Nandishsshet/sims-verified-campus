'use strict';
/** Operations against a REAL PostgreSQL — readiness probe and the housekeeping job. Run with: npm run test:integration */
require('../helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SKIP = !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL (or use `npm run test:integration`)';

describe('SIMS operations', { skip: SKIP }, () => {
  let server; let base; let pool;
  before(() => {
    const { createApp } = require('../../src/app');
    ({ pool } = require('../../src/db/pool'));
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });
  after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

  it('/health is liveness, /health/ready also proves the database answers — both open, neither leaks details', async () => {
    const live = await fetch(`${base}/health`); const ready = await fetch(`${base}/health/ready`);
    assert.equal(live.status, 200); assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');
  });

  it('/health/ready is a bare 503 when the database is unreachable (no connection details in the body)', async () => {
    const real = pool.query;
    pool.query = () => Promise.reject(new Error('connect ECONNREFUSED db.internal:5432 password authentication failed for "sims"'));
    try {
      const r = await fetch(`${base}/health/ready`);
      assert.equal(r.status, 503);
      const text = await r.text();
      assert.equal(JSON.parse(text).status, 'unavailable'); assert.ok(!/ECONNREFUSED|db\.internal|password/.test(text));
    } finally { pool.query = real; }
  });

  it('cleanup removes long-expired refresh / reset tokens and keeps live and recently-expired ones', async () => {
    const { runCleanup } = require('../../src/jobs/cleanup');
    const email = `ops.${Date.now().toString(36)}@test.example`;
    const signup = await fetch(`${base}/auth/signup/university-head`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.70.0.1' }, body: JSON.stringify({ fullName: 'Ops Test', email, password: 'Passw0rd!x', university: { name: `Ops Uni ${Date.now()}` } }) });
    assert.equal(signup.status, 201);
    const uid = (await signup.json()).user.id;

    const hash = (n) => `ops-${uid}-${n}`;
    const add = (n, expires) => pool.query(`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, gen_random_uuid(), $2, now() + $3::interval)`, [uid, hash(n), expires]);
    await add('old', '-3 days'); await add('recent', '-1 hour'); await add('live', '10 days');
    await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '3 days'), ($1, $3, now() + interval '1 hour')`, [uid, hash('rold'), hash('rlive')]);

    const r = await runCleanup();
    assert.ok(r.refreshTokens >= 1 && r.passwordResets >= 1);
    const left = (await pool.query(`SELECT token_hash FROM refresh_tokens WHERE token_hash LIKE $1`, [`ops-${uid}-%`])).rows.map((x) => x.token_hash).sort();
    assert.deepEqual(left, [hash('live'), hash('recent')].sort());
    const resets = (await pool.query(`SELECT token_hash FROM password_reset_tokens WHERE user_id = $1`, [uid])).rows.map((x) => x.token_hash);
    assert.deepEqual(resets, [hash('rlive')]);
  });
});
