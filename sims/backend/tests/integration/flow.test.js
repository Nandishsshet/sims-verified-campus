'use strict';
/**
 * End-to-end onboarding flow against a REAL PostgreSQL:
 *   university head → college (approval) → instructor (approval) → class → students (approval)
 * plus key lifecycle, scope isolation, sessions and password reset.
 *
 * Run with:  npm run test:integration      (spins up a throw-away Postgres)
 */
require('../helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SKIP = !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL (or use `npm run test:integration`)';

describe('SIMS onboarding flow', { skip: SKIP }, () => {
  let server; let base; let pool; let mailer;
  const run = Date.now().toString(36);
  const PW = 'Passw0rd!x';
  let ipCounter = 0;
  const nextIp = () => `10.30.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  /** Minimal HTTP client. `as` = an actor { token, ip }; anonymous calls get a fresh IP. */
  async function api(method, path, { as, body, cookie, ip } = {}) {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip || as?.ip || nextIp() };
    if (as?.token) headers.authorization = `Bearer ${as.token}`;
    if (cookie) headers.cookie = `sims_rt=${cookie}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const setCookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('sims_rt='));
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie, refresh: setCookie?.split(';')[0].slice('sims_rt='.length) };
  }
  const code = (r) => r.body?.error?.code;

  /** Sign up and return an actor. */
  async function signup(kind, extra, label) {
    const email = `${label}.${run}@test.example`;
    const r = await api('POST', `/auth/signup/${kind}`, { body: { fullName: `Test ${label}`, email, password: PW, ...extra } });
    assert.equal(r.status, 201, `signup ${label}: ${JSON.stringify(r.body)}`);
    return { email, token: r.body.accessToken, refresh: r.refresh, user: r.body.user, ip: nextIp(), res: r.body };
  }

  before(async () => {
    const { createApp } = require('../../src/app');
    ({ pool } = require('../../src/db/pool'));
    mailer = require('../../src/utils/mailer');
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  // shared state across the ordered steps below
  const S = {};

  // ================================================================ University → College
  it('university head signs up and receives a University Key', async () => {
    S.uh = await signup('university-head', { university: { name: `Test University ${run}`, headTitle: 'Vice-Chancellor' } }, 'uh');
    assert.match(S.uh.res.universityKey, /^UNI-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(S.uh.user.role, 'university_head');
    S.uniKey = S.uh.res.universityKey;
  });

  it('college admin cannot sign up with a bad or wrong-type key; failures are logged', async () => {
    const mk = (key) => api('POST', '/auth/signup/college-admin', { body: {
      fullName: 'X Admin', email: `bad.${run}@test.example`, password: PW, universityKey: key,
      college: { name: 'Nope College', principalName: 'Dr Nope' } } });
    const a = await mk('UNI-AAAA-BBBB');
    assert.equal(a.status, 400); assert.equal(code(a), 'KEY_INVALID');
    const b = await mk('CLS-AAAA-BBBB');
    assert.equal(b.status, 400); assert.equal(code(b), 'KEY_INVALID');
    assert.equal(a.body.error.message, b.body.error.message, 'same message for every failure reason');
    const { rows } = await pool.query(`SELECT detail FROM key_usage_logs WHERE event = 'join_denied' AND attempted_value IN ('UNI-AAAA-BBBB','CLS-AAAA-BBBB')`);
    assert.ok(rows.length >= 2);
    const u = await pool.query('SELECT 1 FROM users WHERE email = $1', [`bad.${run}@test.example`]);
    assert.equal(u.rowCount, 0, 'no user is created by a failed key redemption');
  });

  it('college admin signs up with the University Key → college is PENDING and has no key yet', async () => {
    S.ca = await signup('college-admin', { universityKey: S.uniKey, college: { name: `Test College ${run}`, principalName: 'Dr Principal', affiliation: 'Test Univ' } }, 'ca');
    assert.equal(S.ca.res.college.status, 'pending');
    assert.equal(S.ca.res.collegeKey, undefined);
    const keys = await api('GET', '/keys/mine', { as: S.ca });
    assert.equal(keys.body.keys[0].key, null);
    assert.equal(code(await api('GET', '/college/instructors', { as: S.ca })), 'ORG_NOT_ACTIVE');
    S.collegeId = S.ca.res.college.id;
  });

  it('only the owning university head can approve; approval issues the College Key', async () => {
    S.uh2 = await signup('university-head', { university: { name: `Other University ${run}` } }, 'uh2');
    const foreign = await api('POST', `/university/colleges/${S.collegeId}/approve`, { as: S.uh2 });
    assert.equal(foreign.status, 404, 'another university cannot see or approve this college');
    assert.equal((await api('GET', '/university/colleges', { as: S.uh2 })).body.colleges.length, 0);

    const list = await api('GET', '/university/colleges', { as: S.uh });
    assert.equal(list.body.colleges[0].status, 'pending');
    const ok = await api('POST', `/university/colleges/${S.collegeId}/approve`, { as: S.uh });
    assert.equal(ok.status, 200);
    assert.match(ok.body.collegeKey, /^COL-/);
    S.colKey = ok.body.collegeKey;
    assert.equal((await api('POST', `/university/colleges/${S.collegeId}/approve`, { as: S.uh })).status, 409);
    assert.equal((await api('GET', '/keys/mine', { as: S.ca })).body.keys[0].key.keyValue, S.colKey);
  });

  // ================================================================ College → Instructor
  it('instructor joins with the College Key but stays pending until the admin approves', async () => {
    S.in1 = await signup('instructor', { collegeKey: S.colKey }, 'in1');
    assert.equal(S.in1.res.membership.status, 'pending');
    const create = await api('POST', '/classes', { as: S.in1, body: { departmentId: S.uh.user.id, branch: 'CSE', admissionYear: 2022, passoutYear: 2026 } });
    assert.equal(code(create), 'MEMBERSHIP_NOT_APPROVED');

    const dept = await api('POST', '/college/departments', { as: S.ca, body: { name: 'Computer Science', code: 'cse', hodName: 'Dr HOD' } });
    assert.equal(dept.status, 201); assert.equal(dept.body.department.code, 'CSE');
    S.deptId = dept.body.department.id;

    const pending = await api('GET', '/college/instructors?status=pending', { as: S.ca });
    assert.equal(pending.body.instructors.length, 1);
    S.in1Membership = pending.body.instructors[0].id;
    assert.equal((await api('POST', `/college/instructors/${S.in1Membership}/approve`, { as: S.ca })).status, 200);
    assert.equal((await api('POST', `/college/instructors/${S.in1Membership}/approve`, { as: S.ca })).status, 409);
  });

  it('second instructor is approved too; role guards hold', async () => {
    S.in2 = await signup('instructor', { collegeKey: S.colKey }, 'in2');
    const m = (await api('GET', '/college/instructors?status=pending', { as: S.ca })).body.instructors[0].id;
    assert.equal((await api('POST', `/college/instructors/${m}/approve`, { as: S.ca })).status, 200);
    assert.equal(code(await api('GET', '/college/instructors', { as: S.in1 })), 'ROLE_FORBIDDEN');
    assert.equal(code(await api('GET', '/university', { as: S.ca })), 'ROLE_FORBIDDEN');
  });

  // ================================================================ Instructor → Class
  it('instructors create classes and receive Class Keys', async () => {
    const bad = await api('POST', '/classes', { as: S.in1, body: { departmentId: '00000000-0000-4000-8000-000000000000', branch: 'CSE', admissionYear: 2022, passoutYear: 2026 } });
    assert.equal(code(bad), 'INVALID_DEPARTMENT');
    const years = await api('POST', '/classes', { as: S.in1, body: { departmentId: S.deptId, branch: 'CSE', admissionYear: 2026, passoutYear: 2022 } });
    assert.equal(code(years), 'VALIDATION_ERROR');

    const a = await api('POST', '/classes', { as: S.in1, body: { departmentId: S.deptId, branch: 'CSE', admissionYear: 2022, passoutYear: 2026, hodName: 'Dr HOD' } });
    assert.equal(a.status, 201);
    assert.match(a.body.classKey, /^CLS-/);
    assert.equal(a.body.class.name, 'CSE 2022-2026');
    S.classA = a.body.class.id; S.keyA = a.body.classKey;

    const b = await api('POST', '/classes', { as: S.in2, body: { departmentId: S.deptId, branch: 'CSE', admissionYear: 2022, passoutYear: 2026, name: 'CSE-B' } });
    S.classB = b.body.class.id; S.keyB = b.body.classKey;
    assert.notEqual(S.keyA, S.keyB);
  });

  // ================================================================ Student → Class
  it('student joins with a Class Key → pending; duplicates and second class are blocked', async () => {
    S.st1 = await signup('student', {}, 'st1');
    assert.equal(code(await api('POST', '/classes', { as: S.st1, body: {} })), 'ROLE_FORBIDDEN');
    assert.equal(code(await api('POST', '/join/class', { as: S.st1, body: { classKey: 'CLS-ZZZZ-ZZZZ' } })), 'KEY_INVALID');

    const j = await api('POST', '/join/class', { as: S.st1, body: { classKey: S.keyA.toLowerCase(), rollNumber: 'CSE001' } });   // lower-case is accepted
    assert.equal(j.status, 201); assert.equal(j.body.status, 'pending');
    S.enrollSt1 = j.body.enrollmentId;
    assert.equal((await api('GET', '/me', { as: S.st1 })).body.context.status, 'pending');
    assert.equal(code(await api('POST', '/join/class', { as: S.st1, body: { classKey: S.keyA } })), 'ALREADY_MEMBER');

    // a different class while one request is live → DB-enforced, and the key use is rolled back
    assert.equal(code(await api('POST', '/join/class', { as: S.st1, body: { classKey: S.keyB } })), 'ALREADY_IN_CLASS');
    const kb = (await api('GET', '/keys/mine', { as: S.in2 })).body.keys[0].key;
    assert.equal(kb.useCount, 0, 'failed join must not consume a key use');
  });

  it('instructor sees only their own class; approval makes the student a member', async () => {
    const pending = await api('GET', `/classes/${S.classA}/enrollments?status=pending`, { as: S.in1 });
    assert.equal(pending.body.enrollments.length, 1);
    assert.equal(pending.body.enrollments[0].roll_number, 'CSE001');

    assert.equal((await api('GET', `/classes/${S.classA}/enrollments`, { as: S.in2 })).status, 404);
    assert.equal((await api('POST', `/classes/${S.classA}/enrollments/${S.enrollSt1}/approve`, { as: S.in2 })).status, 404);
    assert.equal((await api('GET', `/classes/${S.classA}`, { as: S.in2 })).status, 404);

    const ok = await api('POST', `/classes/${S.classA}/enrollments/${S.enrollSt1}/approve`, { as: S.in1, body: {} });
    assert.equal(ok.status, 200); assert.equal(ok.body.enrollment.status, 'approved');
    assert.equal(code(await api('POST', `/classes/${S.classA}/enrollments/${S.enrollSt1}/approve`, { as: S.in1, body: {} })), 'INVALID_STATE');

    const me = (await api('GET', '/me', { as: S.st1 })).body.context;
    assert.equal(me.status, 'approved');
    assert.equal(me.rollNumber, 'CSE001');
    assert.equal(me.class.name, 'CSE 2022-2026');
    assert.equal(me.department, 'Computer Science');
    assert.match(me.college, /^Test College/);
    assert.match(me.university, /^Test University/);
  });

  it('reject → re-request → roll-number clash → approve; remove blocks rejoining', async () => {
    S.st2 = await signup('student', {}, 'st2');
    const j = await api('POST', '/join/class', { as: S.st2, body: { classKey: S.keyA, rollNumber: 'CSE001' } });
    S.enrollSt2 = j.body.enrollmentId;
    assert.equal((await api('POST', `/classes/${S.classA}/enrollments/${S.enrollSt2}/reject`, { as: S.in1, body: { remarks: 'Unknown student' } })).body.enrollment.status, 'rejected');
    assert.equal((await api('GET', '/join/status', { as: S.st2 })).body.status, 'rejected');

    const again = await api('POST', '/join/class', { as: S.st2, body: { classKey: S.keyA, rollNumber: 'CSE001' } });
    assert.equal(again.status, 201);
    assert.equal(code(await api('POST', `/classes/${S.classA}/enrollments/${S.enrollSt2}/approve`, { as: S.in1, body: {} })), 'ROLL_NUMBER_TAKEN');
    assert.equal((await api('POST', `/classes/${S.classA}/enrollments/${S.enrollSt2}/approve`, { as: S.in1, body: { rollNumber: 'CSE002' } })).status, 200);

    const del = await api('DELETE', `/classes/${S.classA}/enrollments/${S.enrollSt2}`, { as: S.in1, body: { remarks: 'Not in this class' } });
    assert.equal(del.body.enrollment.status, 'removed');
    assert.equal((await api('GET', '/me', { as: S.st2 })).body.context.status, 'none');
    assert.equal(code(await api('POST', '/join/class', { as: S.st2, body: { classKey: S.keyA } })), 'REMOVED_FROM_CLASS');

    const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [S.st2.user.id]);
    assert.ok(n.rows[0].n >= 2, 'student is notified of decisions');
    const a = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE class_id = $1 AND action LIKE 'student.%'`, [S.classA]);
    assert.ok(a.rows[0].n >= 4, 'decisions are audited');
  });

  // ================================================================ Key lifecycle
  it('regenerating a class key kills the old key, keeps existing students, logs usage', async () => {
    const regen = await api('POST', `/keys/class/${S.classA}/regenerate`, { as: S.in1, body: {} });
    assert.equal(regen.status, 201);
    S.keyA2 = regen.body.key.keyValue; S.keyA2Id = regen.body.key.id;
    assert.notEqual(S.keyA2, S.keyA);

    S.st3 = await signup('student', {}, 'st3');
    assert.equal(code(await api('POST', '/join/class', { as: S.st3, body: { classKey: S.keyA } })), 'KEY_INVALID');
    assert.equal((await api('POST', '/join/class', { as: S.st3, body: { classKey: S.keyA2 } })).status, 201);

    assert.equal((await api('GET', '/me', { as: S.st1 })).body.context.status, 'approved', 'existing student is unaffected');
    const logs = (await api('GET', `/keys/${S.keyA2Id}/logs`, { as: S.in1 })).body.logs;
    assert.deepEqual(logs.map((l) => l.event).sort(), ['created', 'joined']);
    assert.equal(logs.find((l) => l.event === 'joined').user, 'Test st3');

    const old = await pool.query(`SELECT status, replaced_by FROM access_keys WHERE key_value = $1`, [S.keyA]);
    assert.equal(old.rows[0].status, 'rotated');
    assert.equal(old.rows[0].replaced_by, S.keyA2Id);

    // another instructor / a student cannot manage or read this key
    assert.equal((await api('POST', `/keys/class/${S.classA}/regenerate`, { as: S.in2, body: {} })).status, 404);
    assert.equal((await api('GET', `/keys/${S.keyA2Id}/logs`, { as: S.in2 })).status, 404);
    assert.equal((await api('GET', '/keys/mine', { as: S.st1 })).status, 403);
  });

  it('max uses and expiry are enforced; limits are validated', async () => {
    const cur = (await api('GET', '/keys/mine', { as: S.in1 })).body.keys[0].key;
    assert.equal(cur.useCount, 1);
    assert.equal((await api('PATCH', `/keys/${cur.id}`, { as: S.in1, body: { maxUses: 0 } })).status, 400);
    assert.equal(code(await api('PATCH', `/keys/${cur.id}`, { as: S.in1, body: { expiresAt: '2000-01-01T00:00:00Z' } })), 'INVALID_EXPIRY');

    assert.equal((await api('PATCH', `/keys/${cur.id}`, { as: S.in1, body: { maxUses: 1 } })).status, 200);
    S.st4 = await signup('student', {}, 'st4');
    assert.equal(code(await api('POST', '/join/class', { as: S.st4, body: { classKey: S.keyA2 } })), 'KEY_INVALID', 'key is used up');
    assert.equal((await api('PATCH', `/keys/${cur.id}`, { as: S.in1, body: { maxUses: null } })).status, 200);
    assert.equal((await api('POST', '/join/class', { as: S.st4, body: { classKey: S.keyA2 } })).status, 201);

    // expiry: force the clock instead of sleeping
    await pool.query(`UPDATE access_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`, [cur.id]);
    S.st5 = await signup('student', {}, 'st5');
    assert.equal(code(await api('POST', '/join/class', { as: S.st5, body: { classKey: S.keyA2 } })), 'KEY_INVALID');
    assert.equal((await pool.query('SELECT status FROM access_keys WHERE id = $1', [cur.id])).rows[0].status, 'expired');

    // an expired key can be replaced
    const fresh = await api('POST', `/keys/class/${S.classA}/regenerate`, { as: S.in1, body: {} });
    assert.equal(fresh.status, 201);
    S.keyA3 = fresh.body.key.keyValue;
    assert.equal((await api('POST', '/join/class', { as: S.st5, body: { classKey: S.keyA3 } })).status, 201);
  });

  it('revoke stops joins; revoking twice is a 409', async () => {
    assert.equal((await api('POST', `/keys/class/${S.classA}/revoke`, { as: S.in1 })).status, 200);
    assert.equal((await api('GET', '/keys/mine', { as: S.in1 })).body.keys[0].key, null);
    assert.equal(code(await api('POST', `/keys/class/${S.classA}/revoke`, { as: S.in1 })), 'NO_ACTIVE_KEY');
    const st = await signup('student', {}, 'st6');
    assert.equal(code(await api('POST', '/join/class', { as: st, body: { classKey: S.keyA3 } })), 'KEY_INVALID');
    S.keyA4 = (await api('POST', `/keys/class/${S.classA}/regenerate`, { as: S.in1, body: {} })).body.key.keyValue;
    S.st6 = st;
  });

  it('suspending a college disables its keys; reinstating restores them', async () => {
    assert.equal((await api('POST', `/university/colleges/${S.collegeId}/suspend`, { as: S.uh })).status, 200);
    assert.equal(code(await api('POST', '/join/class', { as: S.st6, body: { classKey: S.keyA4 } })), 'KEY_INVALID');
    assert.equal(code(await api('POST', '/auth/signup/instructor', { body: { fullName: 'Late Joiner', email: `late.${run}@test.example`, password: PW, collegeKey: S.colKey } })), 'KEY_INVALID');
    assert.equal(code(await api('POST', '/college/departments', { as: S.ca, body: { name: 'Physics', code: 'PHY' } })), 'ORG_NOT_ACTIVE');
    assert.equal((await api('POST', `/university/colleges/${S.collegeId}/reinstate`, { as: S.uh })).status, 200);
    assert.equal((await api('POST', '/join/class', { as: S.st6, body: { classKey: S.keyA4 } })).status, 201);
  });

  it('removing an instructor suspends their classes; re-approval restores them', async () => {
    assert.equal((await api('POST', `/college/instructors/${S.in1Membership}/remove`, { as: S.ca })).status, 200);
    assert.equal(code(await api('GET', '/classes', { as: S.in1 })), 'MEMBERSHIP_NOT_APPROVED');
    const late = await signup('student', {}, 'st7');
    assert.equal(code(await api('POST', '/join/class', { as: late, body: { classKey: S.keyA4 } })), 'KEY_INVALID');

    const rejoin = await api('POST', '/join/instructor', { as: S.in1, body: { collegeKey: S.colKey } });
    assert.equal(rejoin.status, 201); assert.equal(rejoin.body.status, 'pending');
    assert.equal((await api('POST', `/college/instructors/${S.in1Membership}/approve`, { as: S.ca })).status, 200);
    assert.equal((await api('GET', '/classes', { as: S.in1 })).body.classes.length, 1);
    assert.equal((await api('POST', '/join/class', { as: late, body: { classKey: S.keyA4 } })).status, 201);
  });

  // ================================================================ Sessions & passwords
  it('login, refresh rotation, reuse detection and logout', async () => {
    const wrong = await api('POST', '/auth/login', { body: { email: S.st1.email, password: 'Wrong0000' } });
    assert.equal(wrong.status, 401); assert.equal(code(wrong), 'INVALID_CREDENTIALS');
    const unknown = await api('POST', '/auth/login', { body: { email: `nobody.${run}@test.example`, password: PW } });
    assert.equal(wrong.body.error.message, unknown.body.error.message, 'no account enumeration');

    const login = await api('POST', '/auth/login', { body: { email: S.st1.email.toUpperCase(), password: PW } });   // email is case-insensitive
    assert.equal(login.status, 200);
    assert.match(login.setCookie, /HttpOnly/i);
    assert.match(login.setCookie, /SameSite=Lax/i);
    assert.match(login.setCookie, /Path=\/api\/v1\/auth/);
    assert.equal(login.body.user.password_hash, undefined);

    const r1 = await api('POST', '/auth/refresh', { cookie: login.refresh });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.refresh, login.refresh, 'refresh token rotates');
    assert.equal((await api('GET', '/me', { as: { token: r1.body.accessToken } })).status, 200);

    // replaying the old (now revoked) token = theft signal → whole family revoked
    assert.equal((await api('POST', '/auth/refresh', { cookie: login.refresh })).status, 401);
    assert.equal((await api('POST', '/auth/refresh', { cookie: r1.refresh })).status, 401, 'family revoked, including the newest token');

    const l2 = await api('POST', '/auth/login', { body: { email: S.st1.email, password: PW } });
    assert.equal((await api('POST', '/auth/logout', { cookie: l2.refresh })).status, 204);
    assert.equal((await api('POST', '/auth/refresh', { cookie: l2.refresh })).status, 401);
  });

  it('forgot / reset password: no enumeration, single use, revokes sessions', async () => {
    const live = await api('POST', '/auth/login', { body: { email: S.st1.email, password: PW } });

    const unknown = await api('POST', '/auth/forgot-password', { body: { email: `ghost.${run}@test.example` } });
    const known = await api('POST', '/auth/forgot-password', { body: { email: S.st1.email } });
    assert.equal(unknown.status, 200); assert.equal(known.status, 200);
    assert.deepEqual(unknown.body, known.body);

    const mail = mailer.outbox.filter((m) => m.to === S.st1.email).pop();
    assert.ok(mail, 'reset mail was "sent"');
    const token = mail.text.match(/token=([\w-]+)/)[1];

    assert.equal((await api('POST', '/auth/reset-password', { body: { token, password: 'weak' } })).status, 400);
    assert.equal((await api('POST', '/auth/reset-password', { body: { token, password: 'NewPassw0rd' } })).status, 200);
    assert.equal(code(await api('POST', '/auth/reset-password', { body: { token, password: 'Another0ne1' } })), 'INVALID_TOKEN', 'token is single use');
    assert.equal((await api('POST', '/auth/login', { body: { email: S.st1.email, password: PW } })).status, 401);
    assert.equal((await api('POST', '/auth/login', { body: { email: S.st1.email, password: 'NewPassw0rd' } })).status, 200);
    assert.equal((await api('POST', '/auth/refresh', { cookie: live.refresh })).status, 401, 'old sessions were revoked');
  });

  it('changing the password requires the current one and signs everything out', async () => {
    const l = await api('POST', '/auth/login', { body: { email: S.st1.email, password: 'NewPassw0rd' } });
    const actor = { token: l.body.accessToken, ip: nextIp() };
    assert.equal(code(await api('POST', '/me/password', { as: actor, body: { currentPassword: 'nope1234', newPassword: 'Brand9New1' } })), 'WRONG_PASSWORD');
    assert.equal((await api('POST', '/me/password', { as: actor, body: { currentPassword: 'NewPassw0rd', newPassword: 'Brand9New1' } })).status, 200);
    assert.equal((await api('POST', '/auth/refresh', { cookie: l.refresh })).status, 401);
    assert.equal((await api('POST', '/auth/login', { body: { email: S.st1.email, password: 'Brand9New1' } })).status, 200);
  });

  // ================================================================ Lockout (last: it pollutes the IP / account it targets)
  it('repeated wrong keys lock the IP and the account, even for a valid key', async () => {
    const guesser = await signup('student', {}, 'guesser');
    const bad = { ...guesser, ip: '10.99.99.99' };
    for (let i = 0; i < 5; i++) {
      assert.equal(code(await api('POST', '/join/class', { as: bad, body: { classKey: 'CLS-AAAA-BBB' + 'CDEFG'[i] } })), 'KEY_INVALID');
    }
    const locked = await api('POST', '/join/class', { as: bad, body: { classKey: S.keyA4 } });
    assert.equal(locked.status, 429); assert.equal(code(locked), 'KEY_LOCKED');
    // same account from another network is locked too
    assert.equal(code(await api('POST', '/join/class', { as: { ...guesser, ip: nextIp() }, body: { classKey: S.keyA4 } })), 'KEY_LOCKED');
    // an unrelated student on the same IP is locked (IP-based)…
    const other = await signup('student', {}, 'bystander');
    assert.equal(code(await api('POST', '/join/class', { as: { ...other, ip: '10.99.99.99' }, body: { classKey: S.keyA4 } })), 'KEY_LOCKED');
    // …but not from a different IP
    assert.equal((await api('POST', '/join/class', { as: { ...other, ip: nextIp() }, body: { classKey: S.keyA4 } })).status, 201);
  });
});
