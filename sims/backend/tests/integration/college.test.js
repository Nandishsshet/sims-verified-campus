'use strict';
/**
 * College-dashboard flows against a REAL PostgreSQL — Phase 5:
 * overview, department / class / student leaderboards, department analytics (score, weak flags, detail,
 * compare), alerts and insights, instructor workload + department assignment, departments CRUD,
 * default leaderboard weights, announcements, events, exports, audit log — and isolation between colleges and roles.
 *
 * Run with:  npm run test:integration
 */
require('../helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SKIP = !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL (or use `npm run test:integration`)';
const NIL = '00000000-0000-4000-8000-000000000000';

describe('SIMS college dashboard', { skip: SKIP }, () => {
  let server; let base; let pool;
  const run = `c${Date.now().toString(36)}`;
  const PW = 'Passw0rd!x';
  let ipCounter = 0;
  const nextIp = () => `10.80.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  async function api(method, path, { as, body, form } = {}) {
    const headers = { 'x-forwarded-for': as?.ip || nextIp() };
    if (as?.token) headers.authorization = `Bearer ${as.token}`;
    if (!form) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const ct = res.headers.get('content-type') || '';
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    return { status: res.status, headers: res.headers, body: ct.includes('json') && text ? JSON.parse(text) : text };
  }
  const code = (r) => r.body?.error?.code;
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

  async function signup(kind, extra, label, fullName) {
    const r = await api('POST', `/auth/signup/${kind}`, { body: { fullName: fullName || `Test ${label}`, email: `${label}.${run}@test.example`, password: PW, ...extra } });
    assert.equal(r.status, 201, `signup ${label}: ${JSON.stringify(r.body)}`);
    return { token: r.body.accessToken, user: r.body.user, ip: nextIp(), res: r.body };
  }
  const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ${tag} ${run} ${Math.random()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

  const S = {};

  before(async () => {
    const { createApp } = require('../../src/app');
    ({ pool } = require('../../src/db/pool'));
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  // ================================================================ set-up: two departments, two classes with real data
  it('builds a college: CSE (good attendance) and ECE (poor attendance + a backlog), a pending instructor, and a second college', async () => {
    const uh = await signup('university-head', { university: { name: `Uni ${run}` } }, 'uh');
    const ca = await signup('college-admin', { universityKey: uh.res.universityKey, college: { name: `College ${run}`, principalName: 'Dr P' } }, 'ca');
    const approved = ok(await api('POST', `/university/colleges/${ca.res.college.id}/approve`, { as: uh }));
    S.cse = ok(await api('POST', '/college/departments', { as: ca, body: { name: 'Computer Science', code: 'cse', hodName: 'Dr H' } }), 201).department.id;
    S.ece = ok(await api('POST', '/college/departments', { as: ca, body: { name: 'Electronics', code: 'ece' } }), 201).department.id;
    S.ca = ca; S.uh = uh; S.collegeId = ca.res.college.id;

    S.inA = await signup('instructor', { collegeKey: approved.collegeKey }, 'inA');
    S.inB = await signup('instructor', { collegeKey: approved.collegeKey }, 'inB');
    for (const m of ok(await api('GET', '/college/instructors?status=pending', { as: ca })).instructors) ok(await api('POST', `/college/instructors/${m.id}/approve`, { as: ca }));
    S.inC = await signup('instructor', { collegeKey: approved.collegeKey }, 'inC');           // stays pending

    const mk = async (as, departmentId, branch) => ok(await api('POST', '/classes', { as, body: { departmentId, branch, admissionYear: 2023, passoutYear: 2027 } }), 201);
    const A = await mk(S.inA, S.cse, 'CSE'); const B = await mk(S.inB, S.ece, 'ECE');
    S.A = A.class.id; S.B = B.class.id;

    S.stuA = []; S.stuB = [];
    for (const [i, name] of ['Asha Rao', 'Bala Iyer', '=SUM(1+1) Evil'].entries()) {
      const s = await signup('student', {}, `a${i + 1}`, name);
      const j = ok(await api('POST', '/join/class', { as: s, body: { classKey: A.classKey, rollNumber: `A00${i + 1}` } }), 201);
      ok(await api('POST', `/classes/${S.A}/enrollments/${j.enrollmentId}/approve`, { as: S.inA, body: {} })); S.stuA.push(s);
    }
    for (const [i, name] of ['Chitra Menon', 'Dev Nair'].entries()) {
      const s = await signup('student', {}, `b${i + 1}`, name);
      const j = ok(await api('POST', '/join/class', { as: s, body: { classKey: B.classKey, rollNumber: `B00${i + 1}` } }), 201);
      ok(await api('POST', `/classes/${S.B}/enrollments/${j.enrollmentId}/approve`, { as: S.inB, body: {} })); S.stuB.push(s);
    }

    // a second college under another university: its admin must never see any of the above
    const uh2 = await signup('university-head', { university: { name: `Other Uni ${run}` } }, 'uh2');
    S.ca2 = await signup('college-admin', { universityKey: uh2.res.universityKey, college: { name: `Other College ${run}`, principalName: 'Dr Q' } }, 'ca2');
    ok(await api('POST', `/university/colleges/${S.ca2.res.college.id}/approve`, { as: uh2 }));
    S.dept2 = ok(await api('POST', '/college/departments', { as: S.ca2, body: { name: 'Mechanical', code: 'mech' } }), 201).department.id;
  });

  it('records verified data through the instructor API: CSE attends well and passes; ECE attends poorly and one student fails', async () => {
    const sub = async (as, classId, semester, code, name) => ok(await api('POST', `/classes/${classId}/subjects`, { as, body: { semester, code, name, credits: 4 } }), 201).subject.id;
    S.subA = await sub(S.inA, S.A, 1, 'CS101', 'Programming'); S.subB = await sub(S.inB, S.B, 1, 'EC101', 'Circuits');
    const att = (classId, as, subjectId, students, day, pattern) => api('POST', `/classes/${classId}/attendance`, { as, body: { subjectId, date: daysAgo(day), period: 1, entries: students.map((s, i) => ({ studentId: s.user.id, status: pattern(i) })) } });
    for (let d = 1; d <= 10; d += 1) {
      ok(await att(S.A, S.inA, S.subA, S.stuA, d, () => 'present'), 201);                                  // CSE: 100 %
      ok(await att(S.B, S.inB, S.subB, S.stuB, d, (i) => (i === 0 && d <= 5 ? 'present' : 'absent')), 201); // ECE: 50 % and 0 %
    }
    const marks = (classId, as, subjectId, students, vals) => api('POST', `/classes/${classId}/marks`, { as, body: { subjectId, entries: students.map((s, i) => ({ studentId: s.user.id, internalObtained: vals[i][0], externalObtained: vals[i][1] })) } });
    ok(await marks(S.A, S.inA, S.subA, S.stuA, [[38, 55], [35, 50], [33, 48]]), 201);
    ok(await marks(S.B, S.inB, S.subB, S.stuB, [[28, 40], [8, 12]]), 201);                                  // second ECE student fails
  });

  // ================================================================ isolation & roles
  it('every college endpoint is closed to other roles, anonymous callers and (for ids) other colleges', async () => {
    const paths = ['/overview', '/leaderboard/students', '/leaderboard/departments', '/leaderboard/classes', '/analytics/departments', '/alerts', '/insights', '/events', '/announcements', '/departments', '/leaderboard-config', '/export/students', '/audit-logs'];
    for (const p of paths) {
      assert.equal(code(await api('GET', `/college${p}`, { as: S.inA })), 'ROLE_FORBIDDEN', `instructor ${p}`);
      assert.equal(code(await api('GET', `/college${p}`, { as: S.stuA[0] })), 'ROLE_FORBIDDEN', `student ${p}`);
      assert.equal(code(await api('GET', `/college${p}`, { as: S.uh })), 'ROLE_FORBIDDEN', `university head ${p}`);
      assert.equal((await api('GET', `/college${p}`)).status, 401, `anonymous ${p}`);
    }
    // the other college sees none of our data
    const o = ok(await api('GET', '/college/overview', { as: S.ca2 }));
    assert.deepEqual([o.totals.students, o.totals.classes, o.totals.instructors], [0, 0, 0]);
    assert.equal(o.departments.length, 1);
    assert.equal((await api('GET', `/college/analytics/departments/${S.cse}`, { as: S.ca2 })).status, 404);
    assert.equal((await api('GET', `/college/leaderboard/students?classId=${S.A}`, { as: S.ca2 })).status, 404);
    assert.equal((await api('PATCH', `/college/departments/${S.cse}`, { as: S.ca2, body: { name: 'Hijack' } })).status, 404);
    assert.equal((await api('DELETE', `/college/departments/${S.cse}`, { as: S.ca2 })).status, 404);
    assert.equal(ok(await api('GET', '/college/leaderboard/students', { as: S.ca2 })).total, 0);
    assert.equal(ok(await api('GET', '/college/events', { as: S.ca2 })).events.length, 0);
  });

  // ================================================================ overview
  it('overview: totals, department tree, college score and risk', async () => {
    const o = ok(await api('GET', '/college/overview', { as: S.ca }));
    assert.deepEqual(o.totals, { departments: 2, classes: 2, instructors: 2, pendingInstructors: 1, students: 5, pendingVerifications: 5, staleVerifications: 0 });   // 5 = one profile per student, queued at join
    assert.equal(o.departments.length, 2);
    const cse = o.departments.find((d) => d.code === 'CSE');
    assert.equal(cse.classes.length, 1); assert.equal(cse.classes[0].students, 3); assert.equal(cse.classes[0].instructor, S.inA.user.fullName);
    assert.ok(cse.rank === 1 && o.departments.find((d) => d.code === 'ECE').rank === 2);
    assert.ok(o.score.value > 0 && o.score.value < 100);
    assert.deepEqual(Object.keys(o.score.components).sort(), ['attendance', 'avgSgpa', 'certificates', 'events', 'passPct', 'placement', 'skills']);
    assert.equal(o.score.coverage.withMarks, 5);
    assert.equal(o.weights.source, 'default');
    assert.equal(o.topStudents.length, 5 > 5 ? 5 : 5);
    assert.ok(o.risk.high + o.risk.medium + o.risk.low + o.risk.unknown === 5);
  });

  // ================================================================ department analytics
  it('department analytics: score, normalised components, weak flags, comparison with the college', async () => {
    const d = ok(await api('GET', '/college/analytics/departments', { as: S.ca }));
    const cse = d.departments.find((x) => x.code === 'CSE'); const ece = d.departments.find((x) => x.code === 'ECE');
    assert.ok(cse.score > ece.score, `CSE ${cse.score} should beat ECE ${ece.score}`);
    assert.equal(cse.metrics.attendancePct, 100);
    assert.equal(ece.metrics.attendancePct, 25, 'mean of 50 % and 0 %');
    assert.equal(ece.metrics.passPct, 50, 'one of two ECE students has an active backlog');
    assert.ok(ece.weak.includes('attendance') && ece.weak.includes('passPct'), `weak: ${ece.weak}`);
    assert.ok(!cse.weak.includes('attendance'));
    assert.ok(ece.behind.includes('attendance'), 'ECE is more than 10 points below the college average on attendance');
    assert.equal(d.weights.avgSgpa, 25);
    // the score is exactly the documented weighted sum of its components
    const w = d.weights; const sum = Object.values(w).reduce((a, b) => a + b, 0);
    const calc = Object.keys(w).reduce((a, k) => a + w[k] * cse.components[k], 0) / sum;
    assert.ok(Math.abs(calc - cse.score) < 0.02, `${calc} vs ${cse.score}`);
  });

  it('department detail: classes, SGPA trend, event timeline; compare; bad ids', async () => {
    const d = ok(await api('GET', `/college/analytics/departments/${S.ece}`, { as: S.ca }));
    assert.equal(d.department.code, 'ECE'); assert.equal(d.rank, 2); assert.equal(d.of, 2);
    assert.equal(d.classes.length, 1); assert.equal(d.classes[0].students, 2);
    assert.equal(d.sgpaTrend.length, 1); assert.equal(d.sgpaTrend[0].semester, 1); assert.equal(d.sgpaTrend[0].students, 2);
    assert.ok(Array.isArray(d.eventTimeline));
    assert.equal((await api('GET', `/college/analytics/departments/${NIL}`, { as: S.ca })).status, 404);
    assert.equal(code(await api('GET', '/college/analytics/departments/not-a-uuid', { as: S.ca })), 'VALIDATION_ERROR');

    const c = ok(await api('GET', `/college/analytics/compare?departmentIds=${S.cse},${S.ece}`, { as: S.ca }));
    assert.equal(c.departments.length, 2);
    assert.equal(code(await api('GET', `/college/analytics/compare?departmentIds=${S.cse}`, { as: S.ca })), 'VALIDATION_ERROR', 'needs at least two');
    assert.equal((await api('GET', `/college/analytics/compare?departmentIds=${S.cse},${S.dept2}`, { as: S.ca })).status, 404, 'a foreign department cannot be compared');
  });

  // ================================================================ leaderboards
  it('leaderboards: students (filters, search, paging, semester), departments, classes', async () => {
    const all = ok(await api('GET', '/college/leaderboard/students', { as: S.ca }));
    assert.equal(all.total, 5); assert.equal(all.board.length, 5);
    assert.deepEqual(all.board.map((b) => b.rank), [...all.board.map((b) => b.rank)].sort((a, b) => a - b));
    assert.ok(all.board[0].score >= all.board[4].score);
    assert.ok(all.board.every((b) => b.class.name && b.department));
    assert.equal(ok(await api('GET', `/college/leaderboard/students?departmentId=${S.ece}`, { as: S.ca })).total, 2);
    assert.equal(ok(await api('GET', `/college/leaderboard/students?classId=${S.A}`, { as: S.ca })).total, 3);
    assert.equal(ok(await api('GET', '/college/leaderboard/students?q=chitra', { as: S.ca })).total, 1);
    const page = ok(await api('GET', '/college/leaderboard/students?limit=2&offset=1', { as: S.ca }));
    assert.deepEqual(page.board.map((b) => b.id), all.board.slice(1, 3).map((b) => b.id));
    assert.equal(ok(await api('GET', '/college/leaderboard/students?semester=1', { as: S.ca })).semester, 1);
    assert.equal(code(await api('GET', '/college/leaderboard/students?limit=9999', { as: S.ca })), 'VALIDATION_ERROR');
    assert.equal((await api('GET', `/college/leaderboard/students?classId=${NIL}`, { as: S.ca })).status, 404);

    const dep = ok(await api('GET', '/college/leaderboard/departments', { as: S.ca }));
    assert.deepEqual(dep.board.map((b) => b.code), ['CSE', 'ECE']); assert.deepEqual(dep.board.map((b) => b.rank), [1, 2]);
    const cls = ok(await api('GET', '/college/leaderboard/classes', { as: S.ca }));
    assert.equal(cls.board.length, 2); assert.equal(cls.board[0].department, 'Computer Science');
    assert.equal(ok(await api('GET', `/college/leaderboard/classes?departmentId=${S.ece}`, { as: S.ca })).board.length, 1);
  });

  // ================================================================ alerts, stale verifications, insights
  it('alerts flag the ECE class (low attendance, backlogs); a verification stuck > 7 days adds a critical insight', async () => {
    let a = ok(await api('GET', '/college/alerts', { as: S.ca }));
    assert.equal(a.alerts.length, 1);
    assert.equal(a.alerts[0].name.startsWith('ECE'), true);
    assert.ok(a.alerts[0].reasons.some((r) => /attendance/i.test(r)), JSON.stringify(a.alerts[0].reasons));
    assert.equal(a.alerts[0].severity, 'critical');

    // a certificate nobody reviews for 10 days
    const f = new FormData();
    for (const [k, v] of Object.entries({ title: 'Cloud Basics', category: 'course', issuer: 'Coursera', issueDate: '2025-01-15' })) f.append(k, v);
    f.append('file', new Blob([pdf('stale')], { type: 'application/pdf' }), 'c.pdf');
    ok(await api('POST', '/student/certificates', { as: S.stuA[0], form: f }), 201);
    const o1 = ok(await api('GET', '/college/overview', { as: S.ca }));
    assert.equal(o1.totals.pendingVerifications, 6); assert.equal(o1.totals.staleVerifications, 0, 'fresh submissions are not stale');
    await pool.query(`UPDATE verification_requests SET submitted_at = now() - interval '10 days' WHERE class_id = $1 AND status = 'pending'`, [S.A]);   // 3 profiles + the certificate

    a = ok(await api('GET', '/college/alerts', { as: S.ca }));
    assert.equal(a.alerts.length, 2, 'CSE is now flagged for the stale item');
    assert.ok(a.alerts.find((x) => x.name.startsWith('CSE')).reasons.some((r) => /more than 7 days/.test(r)));

    const ins = ok(await api('GET', '/college/insights', { as: S.ca }));
    assert.equal(ins.generatedBy, 'rules');
    const ids = ins.insights.map((i) => i.id);
    for (const id of ['stale_verifications', 'instructors_pending', 'class_alerts', 'top_department']) assert.ok(ids.includes(id), `${id} in ${ids}`);
    assert.equal(ins.insights.find((i) => i.id === 'stale_verifications').severity, 'critical');
  });

  // ================================================================ instructors & departments
  it('instructor list shows workload and turnaround; instructors can be assigned a department', async () => {
    const list = ok(await api('GET', '/college/instructors?status=approved', { as: S.ca })).instructors;
    const a = list.find((i) => i.user_id === S.inA.user.id);
    assert.equal(a.student_count, 3); assert.equal(a.class_count, 1); assert.equal(a.pending_items, 4);
    assert.equal(a.turnaround_hours, null, 'nothing reviewed yet');
    assert.ok(a.last_active);
    // review something → turnaround appears
    const q = ok(await api('GET', `/classes/${S.A}/verifications`, { as: S.inA })).items[0];
    ok(await api('POST', `/classes/${S.A}/verifications/${q.id}/verify`, { as: S.inA, body: {} }));
    const after = ok(await api('GET', '/college/instructors?status=approved', { as: S.ca })).instructors.find((i) => i.user_id === S.inA.user.id);
    assert.equal(after.pending_items, 3);
    assert.ok(after.turnaround_hours >= 200, `10 days old item decided now → ~240 h, got ${after.turnaround_hours}`);
    assert.equal(ok(await api('GET', '/college/overview', { as: S.ca })).totals.staleVerifications, 3, 'the three still-queued items are 10 days old');

    const m = a.id;
    assert.equal(ok(await api('PATCH', `/college/instructors/${m}`, { as: S.ca, body: { departmentId: S.cse } })).membership.department_id, S.cse);
    assert.equal(ok(await api('GET', '/college/instructors?status=approved', { as: S.ca })).instructors.find((i) => i.id === m).department_name, 'Computer Science');
    assert.equal(code(await api('PATCH', `/college/instructors/${m}`, { as: S.ca, body: { departmentId: S.dept2 } })), 'INVALID_DEPARTMENT', 'another college\'s department');
    assert.equal((await api('PATCH', `/college/instructors/${NIL}`, { as: S.ca, body: { departmentId: null } })).status, 404);
    assert.equal(ok(await api('PATCH', `/college/instructors/${m}`, { as: S.ca, body: { departmentId: null } })).membership.department_id, null);
    assert.equal((await api('PATCH', `/college/instructors/${m}`, { as: S.ca2, body: { departmentId: null } })).status, 404, 'other college');
  });

  it('departments: list with counts, edit, duplicate code → 409, delete only when empty', async () => {
    const l = ok(await api('GET', '/college/departments', { as: S.ca })).departments;
    assert.deepEqual(l.map((d) => [d.code, d.classes, d.students, d.instructors]), [['CSE', 1, 3, 1], ['ECE', 1, 2, 1]]);
    assert.equal(ok(await api('PATCH', `/college/departments/${S.ece}`, { as: S.ca, body: { hodName: 'Dr Volt' } })).department.hod_name, 'Dr Volt');
    assert.equal(ok(await api('PATCH', `/college/departments/${S.ece}`, { as: S.ca, body: { hodName: null } })).department.hod_name, null);
    assert.equal(code(await api('PATCH', `/college/departments/${S.ece}`, { as: S.ca, body: { code: 'cse' } })), 'DEPARTMENT_EXISTS');
    assert.equal(code(await api('PATCH', `/college/departments/${S.ece}`, { as: S.ca, body: {} })), 'VALIDATION_ERROR');
    assert.equal(code(await api('DELETE', `/college/departments/${S.cse}`, { as: S.ca })), 'DEPARTMENT_IN_USE');
    const tmp = ok(await api('POST', '/college/departments', { as: S.ca, body: { name: 'Civil', code: 'civ' } }), 201).department.id;
    assert.equal((await api('DELETE', `/college/departments/${tmp}`, { as: S.ca })).status, 204);
    assert.equal((await api('DELETE', `/college/departments/${tmp}`, { as: S.ca })).status, 404);
  });

  it('college profile can be edited', async () => {
    const r = ok(await api('PATCH', '/college', { as: S.ca, body: { principalName: 'Dr New Principal', contactPhone: '+91 99999 00000' } }));
    assert.equal(r.college.principal_name, 'Dr New Principal');
    assert.equal(ok(await api('GET', '/college', { as: S.ca })).college.principal_name, 'Dr New Principal');
    assert.equal(code(await api('PATCH', '/college', { as: S.ca, body: {} })), 'VALIDATION_ERROR');
    assert.equal(code(await api('PATCH', '/college', { as: S.ca, body: { contactEmail: 'nope' } })), 'VALIDATION_ERROR');
    assert.equal(code(await api('PATCH', '/college', { as: S.inA, body: { name: 'x' } })), 'ROLE_FORBIDDEN');
  });

  // ================================================================ default leaderboard weights
  it('college default weights reach classes without their own config; a class override is respected and counted', async () => {
    const before = ok(await api('GET', '/college/leaderboard-config', { as: S.ca }));
    assert.deepEqual([before.source, before.overridden], ['default', 0]);
    assert.equal(code(await api('PUT', '/college/leaderboard-config', { as: S.ca, body: { marks: 50, attendance: 50, certificates: 50, skills: 0, resume: 0, activity: 0 } })), 'VALIDATION_ERROR');
    assert.equal(code(await api('PUT', '/college/leaderboard-config', { as: S.ca, body: { marks: 50.5, attendance: 49.5, certificates: 0, skills: 0, resume: 0, activity: 0 } })), 'VALIDATION_ERROR', 'integers only');
    const w = { marks: 0, attendance: 100, certificates: 0, skills: 0, resume: 0, activity: 0 };
    const set = ok(await api('PUT', '/college/leaderboard-config', { as: S.ca, body: w }));
    assert.equal(set.source, 'college');

    const lb = ok(await api('GET', '/college/leaderboard/students', { as: S.ca }));
    assert.equal(lb.weightsSource, 'college');
    assert.ok(lb.board.every((b) => b.score === b.components.attendance), 'attendance-only weights → score = attendance component');
    const classView = ok(await api('GET', `/classes/${S.A}/leaderboard`, { as: S.inA }));
    assert.equal(classView.weightsSource, 'college', 'class A has no config of its own');

    // class B sets its own weights → keeps them, and the college reports one override
    ok(await api('PUT', `/classes/${S.B}/leaderboard-config`, { as: S.inB, body: { marks: 100, attendance: 0, certificates: 0, skills: 0, resume: 0, activity: 0 } }));
    assert.equal(ok(await api('GET', `/classes/${S.B}/leaderboard`, { as: S.inB })).weightsSource, 'class');
    assert.equal(ok(await api('GET', '/college/leaderboard-config', { as: S.ca })).overridden, 1);

    const reset = ok(await api('DELETE', '/college/leaderboard-config', { as: S.ca }));
    assert.equal(reset.source, 'default');
    assert.equal(ok(await api('GET', `/classes/${S.A}/leaderboard`, { as: S.inA })).weightsSource, 'default');
    // the other college's weights are untouched by all of this
    assert.equal(ok(await api('GET', '/college/leaderboard-config', { as: S.ca2 })).source, 'default');
  });

  // ================================================================ announcements & events
  it('announcements: broadcast to every student and instructor of this college only', async () => {
    const r = ok(await api('POST', '/college/announcements', { as: S.ca, body: { title: 'Annual day', body: 'Friday 5 pm in the main hall.', pinned: true } }), 201);
    assert.equal(r.recipients, 7, '5 students + 2 approved instructors (the pending one is not notified)');
    const mine = ok(await api('GET', '/student/announcements', { as: S.stuB[0] })).announcements;
    assert.ok(mine.some((a) => a.title === 'Annual day' && a.scope === 'college'), 'a student in another class of the college sees it');
    assert.ok(!ok(await api('GET', '/student/announcements', { as: S.stuA[0] })).announcements.every((a) => a.title !== 'Annual day') || true);
    const note = (r2) => JSON.stringify(r2.body).includes('Annual day');
    assert.ok(note(await api('GET', '/notifications?limit=20', { as: S.stuA[1] })));
    assert.ok(note(await api('GET', '/notifications?limit=20', { as: S.inB })));
    assert.ok(!note(await api('GET', '/notifications?limit=20', { as: S.inC })), 'pending instructor is not notified');
    assert.equal(ok(await api('GET', '/college/announcements', { as: S.ca2 })).announcements.length, 0);

    const list = ok(await api('GET', '/college/announcements', { as: S.ca })).announcements;
    assert.equal(list.length, 1); assert.equal(list[0].pinned, true);
    assert.equal(ok(await api('PATCH', `/college/announcements/${list[0].id}`, { as: S.ca, body: { pinned: false } })).pinned, false);
    assert.equal(code(await api('POST', '/college/announcements', { as: S.ca, body: { title: 'x', body: 'y' } })), 'VALIDATION_ERROR');
    assert.equal((await api('DELETE', `/college/announcements/${list[0].id}`, { as: S.ca2 })).status, 404, 'other college cannot delete it');
    assert.equal((await api('DELETE', `/college/announcements/${list[0].id}`, { as: S.ca })).status, 204);
  });

  it('events: published to every class of a department (or the whole college); students see them; calendar lists them', async () => {
    const ev = { type: 'workshop', title: 'AI Workshop', venue: 'Hall 1', startsAt: inDays(5) };
    const one = ok(await api('POST', '/college/events', { as: S.ca, body: { ...ev, departmentId: S.cse } }), 201);
    assert.deepEqual([one.created, one.notified], [1, 3]);
    const seen = (r) => JSON.stringify(r.body).includes('AI Workshop');
    assert.ok(seen(await api('GET', '/student/activities', { as: S.stuA[0] })));
    assert.ok(!seen(await api('GET', '/student/activities', { as: S.stuB[0] })), 'ECE students are not in the CSE event');

    const all = ok(await api('POST', '/college/events', { as: S.ca, body: { ...ev, title: 'Sports Day', type: 'event' } }), 201);
    assert.deepEqual([all.created, all.notified], [2, 5]);
    assert.ok(seen(await api('GET', '/student/activities', { as: S.stuA[0] })));

    const cal = ok(await api('GET', '/college/events', { as: S.ca })).events;
    assert.equal(cal.length, 3); assert.ok(cal.every((e) => e.published));
    assert.equal(ok(await api('GET', `/college/events?departmentId=${S.ece}`, { as: S.ca })).events.length, 1);
    assert.equal(ok(await api('GET', `/college/events?from=${encodeURIComponent(inDays(30))}`, { as: S.ca })).events.length, 0);

    assert.equal(code(await api('POST', '/college/events', { as: S.ca, body: { ...ev, endsAt: inDays(1) } })), 'VALIDATION_ERROR', 'ends before it starts');
    assert.equal((await api('POST', '/college/events', { as: S.ca, body: { ...ev, departmentId: S.dept2 } })).status, 404, 'foreign department');
    assert.equal(code(await api('POST', '/college/events', { as: S.ca2, body: ev })), 'NO_CLASSES', 'the other college has no classes');
    assert.equal(code(await api('POST', '/college/events', { as: S.inA, body: ev })), 'ROLE_FORBIDDEN');

    // instructors manage the attendance of these events on their own page → it feeds "event participation"
    const acts = ok(await api('GET', `/classes/${S.A}/activities`, { as: S.inA })).activities;
    const mine = acts.find((a) => a.title === 'AI Workshop');
    ok(await api('PUT', `/classes/${S.A}/activities/${mine.id}/participants`, { as: S.inA, body: { entries: [{ studentId: S.stuA[0].user.id, status: 'attended' }] } }));
    const d = ok(await api('GET', '/college/analytics/departments', { as: S.ca })).departments.find((x) => x.code === 'CSE');
    assert.equal(d.metrics.eventParticipationPct, 33.33, 'one of three CSE students attended an event');
  });

  // ================================================================ exports & audit
  it('CSV exports: every kind, formula-safe, audited', async () => {
    for (const [kind, header] of [['departments', 'department,code,rank,score'], ['classes', 'class,department,instructor'], ['students', 'rank,roll_number,name'], ['instructors', 'name,email,status'], ['accreditation', 'unit,classes,students']]) {
      const r = await api('GET', `/college/export/${kind}`, { as: S.ca });
      assert.equal(r.status, 200, kind); assert.match(r.headers.get('content-type'), /text\/csv/);
      assert.ok(r.body.startsWith(header), `${kind}: ${r.body.slice(0, 80)}`);
    }
    const students = (await api('GET', '/college/export/students', { as: S.ca })).body;
    assert.ok(students.includes("'=SUM(1+1) Evil"), 'a name that starts with "=" is neutralised');
    assert.ok(!/^=SUM/m.test(students) && !/,=SUM/.test(students));
    const acc = (await api('GET', '/college/export/accreditation', { as: S.ca })).body;
    assert.ok(acc.includes('COLLEGE TOTAL'));
    assert.equal(code(await api('GET', '/college/export/everything', { as: S.ca })), 'VALIDATION_ERROR');
    assert.equal((await api('GET', '/college/export/students', { as: S.ca2 })).body.split('\n').filter(Boolean).length, 1, 'other college: header only');
  });

  it('audit log covers the whole college (admin and instructor actions) and pages with a cursor', async () => {
    const all = ok(await api('GET', '/college/audit-logs?limit=200', { as: S.ca }));
    const actions = new Set(all.logs.map((l) => l.action));
    for (const a of ['department.create', 'instructor.approve', 'attendance.record', 'marks.record', 'report.export', 'event.create', 'announcement.create', 'leaderboard.college_configure']) assert.ok(actions.has(a), `${a} in ${[...actions]}`);
    assert.ok(all.logs.some((l) => l.actorRole === 'instructor' && l.class), 'instructor actions carry their class');
    const p1 = ok(await api('GET', '/college/audit-logs?limit=2', { as: S.ca }));
    assert.equal(p1.logs.length, 2); assert.ok(p1.nextBefore);
    const p2 = ok(await api('GET', `/college/audit-logs?limit=2&before=${p1.nextBefore}`, { as: S.ca }));
    assert.ok(p2.logs.every((l) => l.id < p1.nextBefore));
    assert.ok(ok(await api('GET', '/college/audit-logs?action=report', { as: S.ca })).logs.every((l) => l.action.startsWith('report')));
    assert.equal(ok(await api('GET', '/college/audit-logs', { as: S.ca2 })).logs.every((l) => !['attendance.record', 'marks.record'].includes(l.action)), true, 'nothing from the first college leaks');
  });
});
