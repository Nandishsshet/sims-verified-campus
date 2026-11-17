'use strict';
/**
 * University-dashboard flows against a REAL PostgreSQL — Phase 6:
 * overview, college / department / student leaderboards, cross-college analytics (filters, heatmap, year-over-year),
 * alerts and insights, college detail, CSV exports, audit log, announcements, profile, the approve / suspend /
 * reinstate lifecycle — and isolation between universities and roles.
 *
 * Run with:  npm run test:integration
 */
require('../helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SKIP = !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL (or use `npm run test:integration`)';
const NIL = '00000000-0000-4000-8000-000000000000';

describe('SIMS university dashboard', { skip: SKIP }, () => {
  let server; let base; let pool;
  const run = `u${Date.now().toString(36)}`;
  const PW = 'Passw0rd!x';
  let ipCounter = 0;
  const nextIp = () => `10.90.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  async function api(method, path, { as, body } = {}) {
    const headers = { 'x-forwarded-for': as?.ip || nextIp() };
    if (as?.token) headers.authorization = `Bearer ${as.token}`;
    headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  /**
   * One approved college with a department, one approved instructor, one class and its students.
   * `present(i, day)` decides each student's attendance; `marks[i]` is [internal, external].
   */
  async function college(uh, tag, { name, dept = 'cse', students, present, marks }) {
    const ca = await signup('college-admin', { universityKey: uh.res.universityKey, college: { name, principalName: 'Dr P' } }, `ca${tag}`);
    const approved = ok(await api('POST', `/university/colleges/${ca.res.college.id}/approve`, { as: uh }));
    const out = { ca, id: ca.res.college.id, key: approved.collegeKey, students: [] };
    out.deptId = ok(await api('POST', '/college/departments', { as: ca, body: { name: `Dept ${dept}`, code: dept } }), 201).department.id;
    if (!students) return out;

    out.inst = await signup('instructor', { collegeKey: approved.collegeKey }, `in${tag}`);
    for (const m of ok(await api('GET', '/college/instructors?status=pending', { as: ca })).instructors) ok(await api('POST', `/college/instructors/${m.id}/approve`, { as: ca }));
    const cls = ok(await api('POST', '/classes', { as: out.inst, body: { departmentId: out.deptId, branch: dept.toUpperCase(), admissionYear: 2023, passoutYear: 2027 } }), 201);
    out.classId = cls.class.id;
    for (const [i, fullName] of students.entries()) {
      const s = await signup('student', {}, `s${tag}${i + 1}`, fullName);
      const j = ok(await api('POST', '/join/class', { as: s, body: { classKey: cls.classKey, rollNumber: `${tag}00${i + 1}` } }), 201);
      ok(await api('POST', `/classes/${out.classId}/enrollments/${j.enrollmentId}/approve`, { as: out.inst, body: {} }));
      out.students.push(s);
    }
    const subjectId = ok(await api('POST', `/classes/${out.classId}/subjects`, { as: out.inst, body: { semester: 1, code: `${tag}101`, name: 'Core', credits: 4 } }), 201).subject.id;
    for (let d = 1; d <= 10; d += 1) {
      ok(await api('POST', `/classes/${out.classId}/attendance`, { as: out.inst, body: { subjectId, date: daysAgo(d), period: 1, entries: out.students.map((s, i) => ({ studentId: s.user.id, status: present(i, d) ? 'present' : 'absent' })) } }), 201);
    }
    ok(await api('POST', `/classes/${out.classId}/marks`, { as: out.inst, body: { subjectId, entries: out.students.map((s, i) => ({ studentId: s.user.id, internalObtained: marks[i][0], externalObtained: marks[i][1] })) } }), 201);
    return out;
  }

  const S = {};
  const board = async (as = S.uh) => ok(await api('GET', '/university/leaderboard/colleges', { as })).board;

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

  // ================================================================ set-up
  it('builds a university: Alpha (strong), Beta (weak, name starts with "="), a pending college and a suspended one — plus another university', async () => {
    S.uh = await signup('university-head', { university: { name: `Uni ${run}` } }, 'uh');
    S.alpha = await college(S.uh, 'A', {
      name: `Alpha ${run}`, students: ['Asha Rao', 'Bala Iyer', 'Cyrus Dalal'], present: () => true, marks: [[38, 55], [36, 52], [35, 50]],
    });
    S.beta = await college(S.uh, 'B', {
      name: `=Beta ${run}`, students: ['Dev Nair', 'Esha Pillai'], present: (i, d) => i === 0 && d <= 5, marks: [[28, 40], [8, 12]],   // 50 % / 0 % attendance; the second student fails
    });
    // a college that is registered but never approved
    S.pendingCa = await signup('college-admin', { universityKey: S.uh.res.universityKey, college: { name: `Gamma ${run}`, principalName: 'Dr G' } }, 'caC');
    // a college that was approved and then suspended
    S.susp = await college(S.uh, 'D', { name: `Delta ${run}` });
    ok(await api('POST', `/university/colleges/${S.susp.id}/suspend`, { as: S.uh }));

    // an unrelated university with one college and no data
    S.uh2 = await signup('university-head', { university: { name: `Other Uni ${run}` } }, 'uh2');
    S.other = await college(S.uh2, 'X', { name: `Other College ${run}` });
  });

  // ================================================================ overview & colleges
  it('overview: college counts by status, ranked active colleges, pending approvals, verified-only totals', async () => {
    const o = ok(await api('GET', '/university/overview', { as: S.uh }));
    assert.deepEqual(o.totals.colleges, { total: 4, active: 2, pending: 1, suspended: 1 });
    assert.equal(o.totals.students, 5); assert.equal(o.totals.instructors, 2);
    assert.deepEqual(o.colleges.map((c) => [c.name, c.rank, c.students]), [[`Alpha ${run}`, 1, 3], [`=Beta ${run}`, 2, 2]]);
    assert.ok(o.score.value > 0 && o.score.value < 100);
    assert.equal(o.pendingColleges.length, 1); assert.equal(o.pendingColleges[0].name, `Gamma ${run}`);
    assert.deepEqual(o.inactiveColleges.map((c) => c.status).sort(), ['pending', 'suspended'], 'colleges outside the ranking are listed apart from it');
    assert.equal(o.topStudents.length, 5);
  });

  it('GET /university/colleges lists every college with counts and the College Key of approved ones', async () => {
    const { colleges } = ok(await api('GET', '/university/colleges', { as: S.uh }));
    assert.equal(colleges.length, 4);
    assert.equal(colleges[0].status, 'pending', 'pending colleges come first');
    const a = colleges.find((c) => c.id === S.alpha.id);
    assert.deepEqual([a.student_count, a.instructor_count, a.class_count, a.department_count], [3, 1, 1, 1]);
    assert.equal(a.key_value, S.alpha.key);
    assert.equal(colleges.find((c) => c.id === S.pendingCa.res.college.id).key_value, null, 'no key before approval');
  });

  // ================================================================ leaderboards
  it('college leaderboard ranks by score; department board spans colleges; top students expose no private fields', async () => {
    const b = await board();
    assert.deepEqual(b.map((c) => c.rank), [1, 2]); assert.equal(b[0].id, S.alpha.id);
    assert.ok(b[0].score > b[1].score);

    const d = ok(await api('GET', '/university/best-departments', { as: S.uh }));
    assert.equal(d.total, 2); assert.equal(d.board[0].collegeId, S.alpha.id);
    assert.equal(ok(await api('GET', '/university/best-departments?code=cse&limit=1', { as: S.uh })).board.length, 1, 'code is case-insensitive');
    assert.equal(ok(await api('GET', '/university/best-departments?code=zzz', { as: S.uh })).total, 0);

    const t = ok(await api('GET', '/university/top-students?limit=3', { as: S.uh }));
    assert.equal(t.total, 5); assert.equal(t.board.length, 3);
    assert.deepEqual(Object.keys(t.board[0]).sort(), ['college', 'department', 'name', 'rank', 'score']);
    assert.equal(t.board[0].college, `Alpha ${run}`);
    assert.ok(!JSON.stringify(t).includes('@test.example'), 'no emails');
    assert.equal(ok(await api('GET', `/university/top-students?collegeId=${S.beta.id}`, { as: S.uh })).total, 2);
  });

  // ================================================================ analytics
  it('analytics: departments with the same code are grouped across colleges; filters narrow every figure', async () => {
    const a = ok(await api('GET', '/university/analytics', { as: S.uh }));
    assert.equal(a.summary.students, 5); assert.equal(a.byCollege.length, 2);
    assert.equal(a.byDepartment.length, 1, 'CSE in both colleges is one row'); assert.equal(a.byDepartment[0].students, 5);
    assert.equal(a.filters.options.colleges.length, 2); assert.deepEqual(a.filters.options.admissionYears, [2023]);
    assert.ok(a.sgpaTrend.length >= 1);

    assert.equal(ok(await api('GET', `/university/analytics?collegeId=${S.beta.id}`, { as: S.uh })).summary.students, 2);
    assert.equal(ok(await api('GET', '/university/analytics?departmentCode=CSE&admissionYear=2023', { as: S.uh })).summary.students, 5);
    assert.equal(ok(await api('GET', '/university/analytics?admissionYear=2019', { as: S.uh })).summary.students, 0);
    assert.equal((await api('GET', '/university/analytics?collegeId=not-a-uuid', { as: S.uh })).status, 400);
  });

  it('heatmap has a row per active college; year-over-year groups by admission year', async () => {
    const h = ok(await api('GET', '/university/analytics/heatmap', { as: S.uh }));
    assert.equal(h.rows.length, 2); assert.ok(h.metrics.length >= 5);
    assert.deepEqual(h.rows.map((r) => r.rank), [1, 2]);
    const y = ok(await api('GET', '/university/analytics/yoy', { as: S.uh }));
    assert.deepEqual(y.years.map((r) => [r.year, r.students]), [[2023, 5]]);
    assert.equal(y.series.length, 2);
  });

  it('alerts flag the weak college; insights are rule-based and mention pending and suspended colleges', async () => {
    const al = ok(await api('GET', '/university/alerts', { as: S.uh }));
    assert.ok(al.alerts.some((x) => JSON.stringify(x).includes('Beta')), 'Beta is flagged');
    assert.ok(!al.alerts.some((x) => JSON.stringify(x).includes(`Alpha ${run}`)));
    const ins = ok(await api('GET', '/university/insights', { as: S.uh }));
    assert.equal(ins.generatedBy, 'rules');
    const ids = ins.insights.map((i) => i.id);
    assert.ok(ids.includes('colleges_pending') && ids.includes('colleges_suspended') && ids.includes('top_college'), ids.join());
    assert.ok(ins.insights.every((i) => !i.to || i.to.startsWith('/university')));
  });

  it('college detail: rank, departments, admin, key — and 404 for a college of another university', async () => {
    const d = ok(await api('GET', `/university/colleges/${S.alpha.id}`, { as: S.uh }));
    assert.equal(d.rank, 1); assert.equal(d.of, 2); assert.equal(d.departments.length, 1);
    assert.equal(d.college.name, `Alpha ${run}`); assert.ok(d.college.admin.name);
    assert.equal(ok(await api('GET', `/university/colleges/${S.beta.id}`, { as: S.uh })).rank, 2);
    assert.equal((await api('GET', `/university/colleges/${S.other.id}`, { as: S.uh })).status, 404);
    assert.equal((await api('GET', `/university/colleges/${NIL}`, { as: S.uh })).status, 404);
  });

  // ================================================================ exports & audit
  it('CSV exports: one per kind, formula-safe, audited; an unknown kind is rejected', async () => {
    const r = await api('GET', '/university/export/colleges', { as: S.uh });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /university-colleges\.csv/);
    assert.match(r.body.split('\n')[0], /^college,rank,score/); assert.ok(r.body.includes(`Alpha ${run}`));
    assert.ok(!/(^|\n|,)"?=/.test(r.body), 'a leading "=" must be neutralised');
    for (const kind of ['departments', 'cohorts']) assert.equal((await api('GET', `/university/export/${kind}`, { as: S.uh })).status, 200);
    assert.equal((await api('GET', '/university/export/students', { as: S.uh })).status, 400);
    const logs = ok(await api('GET', '/university/audit-logs?action=report.export', { as: S.uh })).logs;
    assert.equal(logs.length, 3); assert.ok(logs.every((l) => l.actorRole === 'university_head'));
  });

  it('audit log: this university only, filterable by action and college, paginated', async () => {
    const all = ok(await api('GET', '/university/audit-logs?limit=200', { as: S.uh }));
    const actions = new Set(all.logs.map((l) => l.action));
    assert.ok(actions.has('college.approve') && actions.has('college.suspend'));
    assert.ok(!all.logs.some((l) => l.college === `Other College ${run}`), 'nothing from the other university');

    const only = ok(await api('GET', '/university/audit-logs?action=college.&limit=200', { as: S.uh })).logs;
    assert.ok(only.length >= 3 && only.every((l) => l.action.startsWith('college.')));
    const byCollege = ok(await api('GET', `/university/audit-logs?collegeId=${S.susp.id}&limit=200`, { as: S.uh })).logs;
    assert.ok(byCollege.length >= 2 && byCollege.every((l) => l.college === `Delta ${run}`));

    const p1 = ok(await api('GET', '/university/audit-logs?limit=2', { as: S.uh }));
    assert.equal(p1.logs.length, 2); assert.ok(p1.nextBefore);
    const p2 = ok(await api('GET', `/university/audit-logs?limit=2&before=${p1.nextBefore}`, { as: S.uh }));
    assert.ok(p2.logs.every((l) => l.id < p1.nextBefore));
  });

  // ================================================================ announcements
  it('announcements reach every college admin, approved instructor and student of an active class — and nobody in another university', async () => {
    assert.equal((await api('POST', '/university/announcements', { as: S.uh, body: { title: 'x', body: 'too short title' } })).status, 400);
    const r = ok(await api('POST', '/university/announcements', { as: S.uh, body: { title: 'Exam calendar', body: 'Semester exams start on 1 March.', pinned: true } }), 201);
    assert.deepEqual(r.breakdown, { collegeAdmins: 4, instructors: 2, students: 5 }, 'admins of pending and suspended colleges are told too');
    assert.equal(r.recipients, 11);

    const seen = (res) => JSON.stringify(res.body).includes('Exam calendar');
    const mine = ok(await api('GET', '/student/announcements', { as: S.beta.students[1] })).announcements;
    assert.ok(mine.some((a) => a.title === 'Exam calendar' && a.scope === 'university'), 'students see it on their dashboard');
    assert.ok(seen(await api('GET', '/notifications?limit=20', { as: S.alpha.students[0] })));
    assert.ok(seen(await api('GET', '/notifications?limit=20', { as: S.alpha.inst })));
    assert.ok(seen(await api('GET', '/notifications?limit=20', { as: S.pendingCa })), 'a pending college admin is notified');
    assert.ok(!seen(await api('GET', '/notifications?limit=20', { as: S.other.ca })), 'the other university hears nothing');
    assert.equal(ok(await api('GET', '/university/announcements', { as: S.uh2 })).announcements.length, 0);

    const list = ok(await api('GET', '/university/announcements', { as: S.uh })).announcements;
    assert.equal(list.length, 1); assert.equal(list[0].pinned, true);
    assert.equal((await api('PATCH', `/university/announcements/${list[0].id}`, { as: S.uh2, body: { pinned: false } })).status, 404);
    assert.equal((await api('DELETE', `/university/announcements/${list[0].id}`, { as: S.uh2 })).status, 404, 'another university cannot touch it');
    assert.equal(ok(await api('PATCH', `/university/announcements/${list[0].id}`, { as: S.uh, body: { pinned: false } })).pinned, false);
    assert.equal((await api('DELETE', `/university/announcements/${list[0].id}`, { as: S.uh })).status, 204);
    assert.equal(ok(await api('GET', '/university/announcements', { as: S.uh })).announcements.length, 0);
  });

  // ================================================================ profile
  it('the head can update the university profile; an empty change or bad email is rejected', async () => {
    const u = ok(await api('PATCH', '/university', { as: S.uh, body: { headTitle: 'Vice Chancellor', address: 'Campus Road', contactEmail: 'Office@Uni.Example' } })).university;
    assert.equal(u.head_title, 'Vice Chancellor'); assert.equal(u.contact_email, 'office@uni.example');
    assert.equal(ok(await api('GET', '/university', { as: S.uh })).university.address, 'Campus Road');
    assert.equal(ok(await api('PATCH', '/university', { as: S.uh, body: { address: null } })).university.address, null);
    assert.equal((await api('PATCH', '/university', { as: S.uh, body: {} })).status, 400);
    assert.equal((await api('PATCH', '/university', { as: S.uh, body: { contactEmail: 'nope' } })).status, 400);
    assert.equal(ok(await api('GET', '/university', { as: S.uh2 })).university.head_title !== 'Vice Chancellor', true, 'the other university is unchanged');
  });

  // ================================================================ lifecycle
  it('suspending a college removes it from rankings and totals; reinstating restores it; bad transitions are 409; foreign ids 404', async () => {
    ok(await api('POST', `/university/colleges/${S.beta.id}/suspend`, { as: S.uh }));
    assert.deepEqual((await board()).map((c) => c.id), [S.alpha.id]);
    const o = ok(await api('GET', '/university/overview', { as: S.uh }));
    assert.equal(o.totals.students, 3); assert.equal(o.totals.colleges.suspended, 2);
    assert.equal(ok(await api('GET', '/university/top-students', { as: S.uh })).total, 3);

    assert.equal(code(await api('POST', `/university/colleges/${S.beta.id}/suspend`, { as: S.uh })), 'INVALID_STATE');
    assert.equal(code(await api('POST', `/university/colleges/${S.alpha.id}/approve`, { as: S.uh })), 'INVALID_STATE');
    assert.equal(code(await api('POST', `/university/colleges/${S.alpha.id}/reinstate`, { as: S.uh })), 'INVALID_STATE');
    assert.equal((await api('POST', `/university/colleges/${S.other.id}/suspend`, { as: S.uh })).status, 404);

    ok(await api('POST', `/university/colleges/${S.beta.id}/reinstate`, { as: S.uh }));
    assert.deepEqual((await board()).map((c) => c.id), [S.alpha.id, S.beta.id]);

    const approved = ok(await api('POST', `/university/colleges/${S.pendingCa.res.college.id}/approve`, { as: S.uh }));
    assert.match(approved.collegeKey, /^COL-/);
    assert.equal(ok(await api('GET', '/university/overview', { as: S.uh })).totals.colleges.pending, 0);
    assert.equal((await board()).length, 3, 'an approved college without classes still appears (unranked)');
  });

  // ================================================================ roles & isolation
  it('every university endpoint is closed to other roles and anonymous callers; the other university sees none of our data', async () => {
    const paths = ['', '/colleges', '/overview', '/leaderboard/colleges', '/best-departments', '/top-students', '/analytics', '/analytics/heatmap', '/analytics/yoy', '/alerts', '/insights', '/announcements', '/export/colleges', '/audit-logs', `/colleges/${S.alpha.id}`];
    for (const p of paths) {
      assert.equal(code(await api('GET', `/university${p}`, { as: S.alpha.ca })), 'ROLE_FORBIDDEN', `college admin ${p}`);
      assert.equal(code(await api('GET', `/university${p}`, { as: S.alpha.inst })), 'ROLE_FORBIDDEN', `instructor ${p}`);
      assert.equal(code(await api('GET', `/university${p}`, { as: S.alpha.students[0] })), 'ROLE_FORBIDDEN', `student ${p}`);
      assert.equal((await api('GET', `/university${p}`)).status, 401, `anonymous ${p}`);
    }
    assert.equal(code(await api('POST', `/university/colleges/${S.alpha.id}/suspend`, { as: S.alpha.ca })), 'ROLE_FORBIDDEN');
    assert.equal(code(await api('POST', '/university/announcements', { as: S.alpha.ca, body: { title: 'Hello', body: 'Hello all' } })), 'ROLE_FORBIDDEN');

    const o = ok(await api('GET', '/university/overview', { as: S.uh2 }));
    assert.deepEqual([o.totals.colleges.total, o.totals.students, o.totals.instructors], [1, 0, 0]);
    assert.equal(ok(await api('GET', '/university/colleges', { as: S.uh2 })).colleges.length, 1);
    assert.equal(ok(await api('GET', '/university/audit-logs?limit=200', { as: S.uh2 })).logs.every((l) => !String(l.college).startsWith('Alpha')), true);
  });
});
