'use strict';
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { signAccessToken, verifyAccessToken, randomToken, sha256 } = require('../src/utils/tokens');
const { requireRole, requireOwnClass, requireApprovedInstructor, requireActiveCollege } = require('../src/middleware/rbac');
const schema = require('../src/modules/auth/auth.schema');
const { createApp } = require('../src/app');

// ------------------------------------------------------------------ tokens
test('access token round-trips and carries role + subject', () => {
  const t = signAccessToken({ id: 'u-1', role: 'student' });
  const p = verifyAccessToken(t);
  assert.equal(p.sub, 'u-1');
  assert.equal(p.role, 'student');
});

test('access token: wrong secret, wrong algorithm and tampering are rejected', () => {
  const forged = jwt.sign({ role: 'university_head' }, 'another-secret-another-secret-12345', { subject: 'u-1', issuer: 'sims' });
  assert.throws(() => verifyAccessToken(forged));
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    + '.' + Buffer.from(JSON.stringify({ sub: 'u-1', role: 'university_head', iss: 'sims' })).toString('base64url') + '.';
  assert.throws(() => verifyAccessToken(none));
  const good = signAccessToken({ id: 'u-1', role: 'student' });
  const [h, , s] = good.split('.');
  const evil = Buffer.from(JSON.stringify({ sub: 'u-1', role: 'university_head', iss: 'sims' })).toString('base64url');
  assert.throws(() => verifyAccessToken(`${h}.${evil}.${s}`));
});

test('random tokens are long, unique and hashed deterministically', () => {
  const a = randomToken(48); const b = randomToken(48);
  assert.notEqual(a, b);
  assert.ok(a.length >= 64);
  assert.equal(sha256(a), sha256(a));
  assert.equal(sha256(a).length, 64);
});

// ------------------------------------------------------------------ RBAC
const run = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err ?? null)));

test('requireRole allows listed roles only', async () => {
  const mw = requireRole('instructor', 'college_admin');
  assert.equal(await run(mw, { user: { role: 'instructor' } }), null);
  const err = await run(mw, { user: { role: 'student' } });
  assert.equal(err.status, 403);
  assert.equal(err.code, 'ROLE_FORBIDDEN');
});

test('requireOwnClass returns 404 (not 403) for a class the instructor does not own', async () => {
  const mw = requireOwnClass();
  assert.equal(await run(mw, { scope: { classIds: ['a', 'b'] }, params: { classId: 'a' } }), null);
  const err = await run(mw, { scope: { classIds: ['a', 'b'] }, params: { classId: 'zzz' } });
  assert.equal(err.status, 404);
});

test('pending instructors and pending colleges are blocked', async () => {
  assert.equal((await run(requireApprovedInstructor, { user: { role: 'instructor' }, scope: { status: 'pending' } })).code, 'MEMBERSHIP_NOT_APPROVED');
  assert.equal(await run(requireApprovedInstructor, { user: { role: 'instructor' }, scope: { status: 'approved' } }), null);
  assert.equal((await run(requireActiveCollege, { user: { role: 'college_admin' }, scope: { status: 'pending' } })).code, 'ORG_NOT_ACTIVE');
  assert.equal(await run(requireActiveCollege, { user: { role: 'college_admin' }, scope: { status: 'active' } }), null);
});

// ------------------------------------------------------------------ validation
test('password policy', () => {
  const base = { fullName: 'Asha Rao', email: 'ASHA@Example.com' };
  assert.equal(schema.signupStudent.safeParse({ ...base, password: 'short1' }).success, false);
  assert.equal(schema.signupStudent.safeParse({ ...base, password: 'allletters' }).success, false);
  assert.equal(schema.signupStudent.safeParse({ ...base, password: '12345678' }).success, false);
  assert.equal(schema.signupStudent.safeParse({ ...base, password: 'a'.repeat(73) + '1' }).success, false);
  const ok = schema.signupStudent.parse({ ...base, password: 'goodpass1' });
  assert.equal(ok.email, 'asha@example.com');                     // normalised
});

test('signup bodies strip unknown fields (no role / status injection)', () => {
  const parsed = schema.signupStudent.parse({ fullName: 'Asha Rao', email: 'a@b.co', password: 'goodpass1', role: 'university_head', isActive: true });
  assert.equal('role' in parsed, false);
  assert.equal('isActive' in parsed, false);
});

// ------------------------------------------------------------------ HTTP (no database needed)
async function withServer(fn) {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
const json = (res) => res.json();

test('health, 404 and JSON error shape', () => withServer(async (base) => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const nf = await fetch(`${base}/nope`);
  assert.equal(nf.status, 404);
  assert.equal((await json(nf)).error.code, 'NOT_FOUND');
}));

test('protected routes reject missing, garbage and expired tokens', () => withServer(async (base) => {
  const none = await fetch(`${base}/me`);
  assert.equal(none.status, 401);

  const bad = await fetch(`${base}/me`, { headers: { authorization: 'Bearer not.a.jwt' } });
  assert.equal(bad.status, 401);
  assert.equal((await json(bad)).error.code, 'INVALID_TOKEN');

  const expired = jwt.sign({ role: 'student' }, process.env.JWT_ACCESS_SECRET, { subject: 'u', issuer: 'sims', expiresIn: -10 });
  const exp = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${expired}` } });
  assert.equal(exp.status, 401);
  assert.equal((await json(exp)).error.code, 'TOKEN_EXPIRED');
}));

test('validation errors are 400 with field paths; malformed JSON is 400', () => withServer(async (base) => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nope' }) });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.path === 'email'));

  const bad = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).error.code, 'INVALID_JSON');
}));

test('refresh without a cookie is 401; logout is idempotent', () => withServer(async (base) => {
  assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST' })).status, 204);
}));

test('security headers are set and x-powered-by is hidden', () => withServer(async (base) => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
}));
