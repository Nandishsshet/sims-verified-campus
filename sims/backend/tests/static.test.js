'use strict';
/** Serving the built SPA from the API (production layout) + the production start-up guards. No database needed. */
require('./helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../src/app');

describe('serving the web app', () => {
  let server; let base; let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sims-dist-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>SIMS</title><div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'theme-init.js'), '/* theme */');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, '..', 'sims-secret.txt'), 'must never be served');
    server = createApp({ frontendDir: dir }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.join(dir, '..', 'sims-secret.txt'), { force: true }); });

  const get = (p, opts) => fetch(`${base}${p}`, { redirect: 'manual', ...opts });

  it('serves index.html at / and for client-side routes, never cached', async () => {
    for (const p of ['/', '/login', '/university/colleges/6a1f', '/student/resume']) {
      const r = await get(p, { headers: { accept: 'text/html' } });
      assert.equal(r.status, 200, p); assert.match(await r.text(), /<div id="root">/);
      assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    }
  });

  it('serves hashed assets with a one-year immutable cache; a missing asset is a 404, not the app', async () => {
    const r = await get('/assets/app-abc123.js');
    assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /max-age=31536000.*immutable/);
    for (const p of ['/assets/missing.js', '/assets/nope', '/missing.png']) assert.equal((await get(p)).status, 404, p);
  });

  it('keeps /api for the API: unknown API routes are JSON 404s, health works, other methods do not reach the SPA', async () => {
    const miss = await get('/api/v1/nope');
    assert.equal(miss.status, 404); assert.equal((await miss.json()).error.code, 'NOT_FOUND');
    assert.equal((await (await get('/api/v1/health')).json()).status, 'ok');
    assert.equal((await get('/login', { method: 'POST' })).status, 404);
  });

  it('cannot be tricked into serving files outside the web root', async () => {
    for (const p of ['/..%2fsims-secret.txt', '/%2e%2e/sims-secret.txt', '/assets/..%2f..%2fsims-secret.txt', '/.env']) {
      const r = await get(p);
      assert.ok(!(await r.text()).includes('must never be served'), p);
    }
  });

  it('sends a CSP that forbids inline scripts, plus the other helmet headers', async () => {
    const r = await get('/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /img-src 'self' data: blob:/, 'the profile photo is shown from an object URL');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-powered-by'), null);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/, 'off while COOKIE_SECURE is false (test env), so plain http keeps working');
  });

  it('the built page really has no inline script (the CSP would block it)', () => {
    const built = path.join(__dirname, '../../frontend/dist/index.html');
    if (!fs.existsSync(built)) return;                                   // frontend not built in this checkout
    const scripts = [...fs.readFileSync(built, 'utf8').matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0 && scripts.every((a) => /\bsrc=/.test(a)), `inline <script> in index.html: ${scripts.join(' | ')}`);
  });

  it('an API-only server (no dist) answers unknown paths with JSON 404', async () => {
    const s = createApp({ frontendDir: 'off' }).listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/login`);
      assert.equal(r.status, 404); assert.equal((await r.json()).error.code, 'NOT_FOUND');
    } finally { s.close(); }
  });
});

describe('production start-up guards', () => {
  const load = (env) => spawnSync(process.execPath, ['-e', "const e = require('./src/config/env'); console.log(JSON.stringify({ secure: e.COOKIE_SECURE }))"], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://x:y@localhost/z', ...env },
  });
  const GOOD = 'k7Qe2mV9xLp4Zt8RbN1sYc6HwD3uFa5JgT0oXiEvMn2';

  it('refuses a production boot that still uses the placeholder secret from .env.example', () => {
    const r = load({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change-me-to-a-long-random-string-of-at-least-32-chars' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /placeholder/);
  });
  it('accepts a real secret; cookies are Secure by default in production and can be relaxed explicitly', () => {
    assert.equal(JSON.parse(load({ NODE_ENV: 'production', JWT_ACCESS_SECRET: GOOD }).stdout).secure, true);
    assert.equal(JSON.parse(load({ NODE_ENV: 'production', JWT_ACCESS_SECRET: GOOD, COOKIE_SECURE: 'false' }).stdout).secure, false);
    assert.equal(JSON.parse(load({ NODE_ENV: 'development', JWT_ACCESS_SECRET: GOOD }).stdout).secure, false);
  });
  it('rejects a secret shorter than 32 characters in any mode', () => {
    const r = load({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'short' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /at least 32/);
  });
  it('the demo seed refuses to run against a production environment', () => {
    const r = spawnSync(process.execPath, ['scripts/seed-demo.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: 'postgresql://x:y@localhost/z', JWT_ACCESS_SECRET: GOOD } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing to seed demo data/);
  });
});
