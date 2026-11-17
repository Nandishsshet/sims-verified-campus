'use strict';
/**
 * Class-dashboard (instructor) flows against a REAL PostgreSQL — Phase 4:
 * subjects, attendance & marks entry, CSV import, the verification center, analytics, leaderboard
 * weights, class life (announcements / activities / assignments / notes / parent notices), exports,
 * audit log and — throughout — isolation between classes and roles.
 *
 * Run with:  npm run test:integration
 */
require('../helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SKIP = !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL (or use `npm run test:integration`)';

describe('SIMS instructor / class dashboard', { skip: SKIP }, () => {
  let server; let base; let pool;
  const run = `i${Date.now().toString(36)}`;
  const PW = 'Passw0rd!x';
  let ipCounter = 0;
  const nextIp = () => `10.70.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  async function api(method, path, { as, body, form } = {}) {
    const headers = { 'x-forwarded-for': as?.ip || nextIp() };
    if (as?.token) headers.authorization = `Bearer ${as.token}`;
    if (!form) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const ct = res.headers.get('content-type') || '';
    const raw = Buffer.from(await res.arrayBuffer());
    const text = raw.toString('utf8');
    return { status: res.status, headers: res.headers, raw, body: ct.includes('json') && text ? JSON.parse(text) : text };
  }
  const code = (r) => r.body?.error?.code;
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

  async function signup(kind, extra, label, fullName) {
    const r = await api('POST', `/auth/signup/${kind}`, { body: { fullName: fullName || `Test ${label}`, email: `${label}.${run}@test.example`, password: PW, ...extra } });
    assert.equal(r.status, 201, `signup ${label}: ${JSON.stringify(r.body)}`);
    return { token: r.body.accessToken, user: r.body.user, ip: nextIp(), res: r.body };
  }
  const csvForm = (text, name = 'data.csv') => { const f = new FormData(); f.append('file', new Blob([text], { type: 'text/csv' }), name); return f; };
  const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ${tag} ${run} ${Math.random()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
  const certForm = (file, title) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ title, category: 'course', issuer: 'Coursera', issueDate: '2025-01-15' })) f.append(k, v);
    f.append('file', new Blob([file], { type: 'application/pdf' }), 'c.pdf');
    return f;
  };

  const S = {};
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

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

  // ================================================================ hierarchy
  it('builds a college with two instructors (two classes) and four students in class A', async () => {
    const uh = await signup('university-head', { university: { name: `Uni ${run}` } }, 'uh');
    const ca = await signup('college-admin', { universityKey: uh.res.universityKey, college: { name: `College ${run}`, principalName: 'Dr P' } }, 'ca');
    const approved = ok(await api('POST', `/university/colleges/${ca.res.college.id}/approve`, { as: uh }));
    const dept = ok(await api('POST', '/college/departments', { as: ca, body: { name: 'Computer Science', code: 'cse', hodName: 'Dr H' } }), 201);

    S.inA = await signup('instructor', { collegeKey: approved.collegeKey }, 'inA');
    S.inB = await signup('instructor', { collegeKey: approved.collegeKey }, 'inB');
    for (const m of ok(await api('GET', '/college/instructors?status=pending', { as: ca })).instructors) ok(await api('POST', `/college/instructors/${m.id}/approve`, { as: ca }));
    const mk = async (as, branch) => ok(await api('POST', '/classes', { as, body: { departmentId: dept.department.id, branch, admissionYear: 2023, passoutYear: 2027 } }), 201);
    const A = await mk(S.inA, 'CSE'); const B = await mk(S.inB, 'ECE');
    S.A = A.class.id; S.keyA = A.classKey; S.B = B.class.id; S.ca = ca; S.uh = uh; S.collegeId = ca.res.college.id;

    // names chosen on purpose: one starts with "=" to prove CSV exports neutralise formulas
    S.stu = [];
    for (const [i, name] of ['Asha Rao', 'Bala Iyer', '=SUM(1+1) Evil', 'देव नायर'].entries()) {
      const s = await signup('student', {}, `s${i + 1}`, name);
      const j = ok(await api('POST', '/join/class', { as: s, body: { classKey: S.keyA, rollNumber: `R00${i + 1}` } }), 201);
      s.enrollment = j.enrollmentId; S.stu.push(s);
    }
    S.stuB = await signup('student', {}, 'sb', 'Other Class');
    const jb = ok(await api('POST', '/join/class', { as: S.stuB, body: { classKey: B.classKey, rollNumber: 'B001' } }), 201);
    ok(await api('POST', `/classes/${S.B}/enrollments/${jb.enrollmentId}/approve`, { as: S.inB, body: {} }));
  });

  it('join requests: approve / reject through the class API, with the first student left pending', async () => {
    const [s1, s2, s3, s4] = S.stu;
    for (const s of [s1, s2, s3]) ok(await api('POST', `/classes/${S.A}/enrollments/${s.enrollment}/approve`, { as: S.inA, body: {} }));
    ok(await api('POST', `/classes/${S.A}/enrollments/${s4.enrollment}/reject`, { as: S.inA, body: { remarks: 'Wrong class' } }));
    ok(await api('POST', `/classes/${S.A}/enrollments/${s4.enrollment}/approve`, { as: S.inA, body: {} }));   // change of mind
    const list = ok(await api('GET', `/classes/${S.A}/enrollments?status=approved`, { as: S.inA }));
    assert.equal(list.enrollments.length, 4);
  });

  // ================================================================ isolation & roles
  it('role and class isolation: students/others cannot use class endpoints; a foreign class id is a 404', async () => {
    const paths = ['/verifications', '/students', '/analytics/overview', '/leaderboard', '/subjects', '/announcements', '/audit-logs', '/export/students'];
    for (const p of paths) {
      assert.equal((await api('GET', `/classes/${S.A}${p}`, { as: S.inB })).status, 404, `instructor B must not read class A ${p}`);
      assert.equal(code(await api('GET', `/classes/${S.A}${p}`, { as: S.stu[0] })), 'ROLE_FORBIDDEN', `student must not read ${p}`);
      assert.equal(code(await api('GET', `/classes/${S.A}${p}`, { as: S.ca })), 'ROLE_FORBIDDEN', `college admin must not read ${p}`);
      assert.equal((await api('GET', `/classes/${S.A}${p}`)).status, 401);
    }
    for (const [m, p, body] of [['POST', '/attendance', { subjectId: '00000000-0000-4000-8000-000000000000', date: today, entries: [] }], ['PATCH', '', { name: 'Hijacked' }], ['POST', '/announcements', { title: 'x', body: 'yyyy' }]]) {
      assert.equal((await api(m, `/classes/${S.A}${p}`, { as: S.inB, body })).status, 404, `${m} ${p}`);
    }
    assert.equal((await api('GET', `/classes/${S.A}/verifications/00000000-0000-4000-8000-000000000000`, { as: S.inA })).status, 404);
  });

  // ================================================================ subjects & class settings
  it('subjects: create, duplicate → 409, edit, list by semester; class settings and timetable', async () => {
    S.subj = {};
    for (const [c, n, cr] of [['CS101', 'Programming', 4], ['CS102', 'Mathematics', 4], ['CS103', 'Physics', 3]]) {
      S.subj[c] = ok(await api('POST', `/classes/${S.A}/subjects`, { as: S.inA, body: { semester: 1, code: c.toLowerCase(), name: n, credits: cr } }), 201).subject.id;
    }
    S.subj.CS201 = ok(await api('POST', `/classes/${S.A}/subjects`, { as: S.inA, body: { semester: 2, code: 'CS201', name: 'Data Structures', credits: 4, isLab: false } }), 201).subject.id;
    assert.equal(code(await api('POST', `/classes/${S.A}/subjects`, { as: S.inA, body: { semester: 1, code: 'CS101', name: 'Dup', credits: 3 } })), 'CONFLICT');
    assert.equal(code(await api('POST', `/classes/${S.A}/subjects`, { as: S.inA, body: { semester: 13, code: 'X1', name: 'Bad', credits: 3 } })), 'VALIDATION_ERROR');
    const list = ok(await api('GET', `/classes/${S.A}/subjects?semester=1`, { as: S.inA }));
    assert.deepEqual(list.subjects.map((s) => s.code), ['CS101', 'CS102', 'CS103'], 'codes are upper-cased');
    assert.equal(ok(await api('PATCH', `/classes/${S.A}/subjects/${S.subj.CS103}`, { as: S.inA, body: { name: 'Engineering Physics' } })).subject.name, 'Engineering Physics');
    assert.equal(code(await api('PATCH', `/classes/${S.A}/subjects/${S.subj.CS103}`, { as: S.inA, body: {} })), 'VALIDATION_ERROR');

    assert.equal(ok(await api('PATCH', `/classes/${S.A}`, { as: S.inA, body: { currentSemester: 2, hodName: 'Dr New' } })).class.currentSemester, 2);
    ok(await api('PATCH', `/classes/${S.A}`, { as: S.inA, body: { currentSemester: 1 } }));
    assert.equal(code(await api('PATCH', `/classes/${S.A}`, { as: S.inA, body: { currentSemester: 99 } })), 'VALIDATION_ERROR');

    const slots = [{ subjectId: S.subj.CS101, dayOfWeek: 1, startsAt: '09:00', endsAt: '10:00', room: 'R1' }, { subjectId: S.subj.CS102, dayOfWeek: 1, startsAt: '10:00', endsAt: '11:00' }];
    assert.equal(ok(await api('PUT', `/classes/${S.A}/timetable`, { as: S.inA, body: { slots } })).saved, 2);
    assert.equal(code(await api('PUT', `/classes/${S.A}/timetable`, { as: S.inA, body: { slots: [...slots, { subjectId: S.subj.CS103, dayOfWeek: 1, startsAt: '09:30', endsAt: '10:30' }] } })), 'TIMETABLE_OVERLAP');
    assert.equal(code(await api('PUT', `/classes/${S.A}/timetable`, { as: S.inA, body: { slots: [{ subjectId: '00000000-0000-4000-8000-000000000000', dayOfWeek: 2, startsAt: '09:00', endsAt: '10:00' }] } })), 'INVALID_SUBJECT');
    assert.equal(ok(await api('GET', `/classes/${S.A}/timetable`, { as: S.inA })).slots.length, 2, 'a rejected PUT leaves the old timetable intact');
    const mine = ok(await api('GET', '/student/timetable', { as: S.stu[0] }));
    assert.ok(JSON.stringify(mine).includes('CS101'), 'students see the timetable');
  });

  // ================================================================ attendance
  it('attendance: sheet → record → correct; duplicates update instead of failing; validation', async () => {
    const [s1, s2, s3, s4] = S.stu;
    const sheet = ok(await api('GET', `/classes/${S.A}/attendance/sheet?subjectId=${S.subj.CS101}&date=${today}&period=1`, { as: S.inA }));
    assert.equal(sheet.students.length, 4); assert.ok(sheet.students.every((s) => s.status === null));
    assert.deepEqual(sheet.students.map((s) => s.rollNumber), ['R001', 'R002', 'R003', 'R004']);

    const entries = (arr) => arr.map((st, i) => ({ studentId: S.stu[i].user.id, status: st }));
    // 12 sessions for CS101: s1 always present, s2 half, s3 never, s4 mostly
    for (let d = 1; d <= 12; d += 1) {
      const r = ok(await api('POST', `/classes/${S.A}/attendance`, { as: S.inA, body: { subjectId: S.subj.CS101, date: daysAgo(d), period: 1, entries: entries(['present', d % 2 ? 'present' : 'absent', 'absent', d === 1 ? 'absent' : 'late']) } }), 201);
      assert.equal(r.inserted, 4);
    }
    const again = ok(await api('POST', `/classes/${S.A}/attendance`, { as: S.inA, body: { subjectId: S.subj.CS101, date: daysAgo(1), period: 1, entries: entries(['present', 'present', 'absent', 'present']) } }), 201);
    assert.deepEqual([again.inserted, again.updated], [0, 4], 're-posting corrects the record');
    const filled = ok(await api('GET', `/classes/${S.A}/attendance/sheet?subjectId=${S.subj.CS101}&date=${daysAgo(1)}&period=1`, { as: S.inA }));
    assert.deepEqual(filled.students.map((s) => s.status), ['present', 'present', 'absent', 'present']);
    assert.ok(filled.students.every((s) => s.verified === true && s.source === 'instructor'));

    // what students see is computed from these verified rows
    const a1 = ok(await api('GET', '/student/attendance?semester=all', { as: s1 }));
    assert.equal(a1.overall.percentage, 100);
    assert.equal(ok(await api('GET', '/student/attendance?semester=all', { as: s3 })).overall.percentage, 0);

    // validation
    const bad = (body) => api('POST', `/classes/${S.A}/attendance`, { as: S.inA, body: { subjectId: S.subj.CS101, date: today, entries: entries(['present']), ...body } });
    assert.equal(code(await bad({ date: '2999-01-01' })), 'VALIDATION_ERROR');
    assert.equal(code(await bad({ date: '2025-02-31' })), 'VALIDATION_ERROR');
    assert.equal(code(await bad({ entries: [{ studentId: s1.user.id, status: 'sleeping' }] })), 'VALIDATION_ERROR');
    assert.equal(code(await bad({ entries: [] })), 'VALIDATION_ERROR');
    assert.equal(code(await bad({ subjectId: '00000000-0000-4000-8000-000000000000' })), 'INVALID_SUBJECT');
    assert.equal(code(await bad({ entries: [{ studentId: S.stuB.user.id, status: 'present' }] })), 'INVALID_STUDENT', 'a student from another class cannot be marked');
  });

  it('an instructor entry supersedes a student claim for the same slot and closes its request', async () => {
    const s2 = S.stu[1];
    const day = daysAgo(20);
    const claim = ok(await api('POST', '/student/attendance/claims', { as: s2, body: { subjectId: S.subj.CS102, date: day, period: 1, note: 'Class was held but not marked' } }), 201).claim;
    const q = ok(await api('GET', `/classes/${S.A}/verifications?type=attendance`, { as: S.inA }));
    assert.equal(q.items.length, 1); assert.equal(q.items[0].entityId, claim.id);
    ok(await api('POST', `/classes/${S.A}/attendance`, { as: S.inA, body: { subjectId: S.subj.CS102, date: day, period: 1, entries: [{ studentId: s2.user.id, status: 'absent' }] } }), 201);
    const row = (await pool.query('SELECT status, source, verification_status FROM attendance_records WHERE id = $1', [claim.id])).rows[0];
    assert.deepEqual([row.status, row.source, row.verification_status], ['absent', 'instructor', 'verified'], 'instructor value wins');
    assert.equal(ok(await api('GET', `/classes/${S.A}/verifications?type=attendance`, { as: S.inA })).items.length, 0);
  });

  // ================================================================ marks
  it('marks: record with derived grades, validation, backlog re-attempt; students see the result', async () => {
    const [s1, s2, s3] = S.stu;
    const m = (subj, vals, extra = {}) => api('POST', `/classes/${S.A}/marks`, { as: S.inA, body: { subjectId: S.subj[subj], entries: vals.map(([i, io, eo]) => ({ studentId: S.stu[i].user.id, internalObtained: io, externalObtained: eo })), ...extra } });
    ok(await m('CS101', [[0, 38, 55], [1, 28, 38], [2, 10, 12], [3, 30, 40]]), 201);
    ok(await m('CS102', [[0, 36, 50], [1, 30, 40], [2, 14, 20]]), 201);
    const sheet = ok(await api('GET', `/classes/${S.A}/marks/sheet?subjectId=${S.subj.CS101}`, { as: S.inA }));
    assert.equal(sheet.students[0].internalObtained, 38); assert.equal(sheet.internalMax, 40);

    const row = (await pool.query('SELECT grade, grade_points, is_pass, source, verification_status FROM marks WHERE student_id = $1 AND subject_id = $2', [s1.user.id, S.subj.CS101])).rows[0];
    assert.equal(row.is_pass, true); assert.equal(row.source, 'instructor'); assert.equal(row.verification_status, 'verified'); assert.ok(Number(row.grade_points) >= 9);
    assert.equal((await pool.query('SELECT is_pass FROM marks WHERE student_id = $1 AND subject_id = $2', [s3.user.id, S.subj.CS101])).rows[0].is_pass, false, 'fails below the pass mark');

    assert.equal(code(await m('CS101', [[0, 45, 10]])), 'VALIDATION_ERROR', 'internal above its maximum');
    assert.equal(code(await m('CS101', [[0, 10, 10]], { internalMax: 0 })), 'VALIDATION_ERROR');
    assert.equal(code(await m('CS101', [[0, 10, -1]])), 'VALIDATION_ERROR');
    assert.equal(code(await api('POST', `/classes/${S.A}/marks`, { as: S.inA, body: { subjectId: S.subj.CS101, entries: [{ studentId: S.stuB.user.id, internalObtained: 1, externalObtained: 1 }] } })), 'INVALID_STUDENT');

    const ac = ok(await api('GET', '/student/academics', { as: s1 }));
    assert.ok(ac.cgpa >= 9, `cgpa ${ac.cgpa}`);
    const ac3 = ok(await api('GET', '/student/academics', { as: s3 }));
    assert.equal(ac3.activeBacklogs.length, 2, 'CS101 and CS102 both failed');

    // supplementary exam: attempt 2 replaces the failed attempt in SGPA/CGPA
    ok(await m('CS101', [[2, 30, 40]], { attempt: 2 }), 201);
    assert.equal(ok(await api('GET', '/student/academics', { as: s3 })).activeBacklogs.length, 1, 'CS101 cleared, CS102 still open');
    // correcting a mark overwrites rather than duplicating
    const upd = ok(await m('CS102', [[1, 32, 42]]), 201);
    assert.deepEqual([upd.inserted, upd.updated], [0, 1]);
  });

  // ================================================================ CSV import
  it('CSV import: template, dry run, partial success with a row-level error report, safety checks', async () => {
    const tpl = await api('GET', `/classes/${S.A}/imports/template/attendance`, { as: S.inA });
    assert.equal(tpl.status, 200); assert.match(tpl.headers.get('content-type'), /text\/csv/);
    assert.ok(tpl.body.startsWith('roll_number,subject_code,date,period,status'));
    assert.ok(tpl.body.includes('R001'), 'the template uses a real roll number from this class');
    assert.equal((await api('GET', `/classes/${S.A}/imports/template/students`, { as: S.inA })).status, 400);

    const text = [
      'roll_number,subject_code,date,period,status',
      `R001,CS102,${daysAgo(5)},1,present`,
      `R002,CS102,${daysAgo(5)},1,Absent`,                 // case-insensitive status
      `R999,CS102,${daysAgo(5)},1,present`,                 // unknown roll  (line 4)
      `R003,NOPE,${daysAgo(5)},1,present`,                  // unknown subject (line 5)
      `R004,CS102,2999-01-01,1,present`,                    // future (line 6)
      `R004,CS102,${daysAgo(5)},1,maybe`,                   // bad status (line 7)
      `R004,CS102,${daysAgo(5)},13,present`,                // bad period (line 8)
      `R004,CS102,${daysAgo(5)},1,present`,
    ].join('\n');

    const dry = ok(await api('POST', `/classes/${S.A}/attendance/import?dryRun=1`, { as: S.inA, form: csvForm(text) }));
    assert.equal(dry.dryRun, true); assert.equal(dry.totalRows, 8); assert.equal(dry.okRows, 3); assert.equal(dry.errorRows, 5);
    assert.equal((await pool.query(`SELECT 1 FROM attendance_records WHERE subject_id = $1 AND attendance_date = $2`, [S.subj.CS102, daysAgo(5)])).rowCount, 0, 'dry run writes nothing');
    assert.equal((await pool.query(`SELECT 1 FROM import_jobs WHERE class_id = $1`, [S.A])).rowCount, 0, 'dry run creates no job');

    const real = ok(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, form: csvForm(text, 'week.csv') }), 201);
    assert.equal(real.status, 'done'); assert.equal(real.inserted, 3);
    assert.deepEqual(real.errorReport.map((e) => [e.row, e.field]), [[4, 'roll_number'], [5, 'subject_code'], [6, 'date'], [7, 'status'], [8, 'period']]);
    const job = ok(await api('GET', `/classes/${S.A}/imports/${real.jobId}`, { as: S.inA }));
    assert.equal(job.okRows, 3); assert.equal(job.errorReport.length, 5); assert.equal(job.fileName, 'week.csv');
    assert.equal(ok(await api('GET', `/classes/${S.A}/imports`, { as: S.inA })).imports.length, 1);
    assert.equal((await api('GET', `/classes/${S.A}/imports/${real.jobId}`, { as: S.inB })).status, 404, 'import jobs are class-scoped');

    // a file with nothing valid is a failed job (422) and writes nothing
    const none = await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, form: csvForm('roll_number,subject_code,date,status\nZZ,CS101,2025-01-01,present\n') });
    assert.equal(none.status, 422); assert.equal(none.body.status, 'failed');

    // structural problems
    assert.equal(code(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, form: csvForm('roll_number,date\nR001,2025-01-01\n') })), 'MISSING_COLUMNS');
    assert.equal(code(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, form: csvForm('roll_number,subject_code,date,status\n') })), 'EMPTY_FILE');
    assert.equal(code(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, form: csvForm('a,b\n"broken,1\n') })), 'INVALID_CSV');
    const binary = new FormData(); binary.append('file', new Blob([Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 1])]), 'x.csv');
    assert.equal(code(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, form: binary })), 'INVALID_FILE_TYPE');
    assert.equal(code(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, body: {} })), 'NO_FILE');
    const huge = csvForm('roll_number,subject_code,date,status\n' + 'R001,CS101,2025-01-01,present\n'.repeat(40000));
    assert.equal(code(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inA, form: huge })), 'FILE_TOO_LARGE');
    assert.equal((await api('POST', `/classes/${S.A}/attendance/import`, { as: S.inB, form: csvForm(text) })).status, 404);
    assert.equal(code(await api('POST', `/classes/${S.A}/attendance/import`, { as: S.stu[0], form: csvForm(text) })), 'ROLE_FORBIDDEN');
  });

  it('marks CSV import: optional columns, defaults, semester disambiguation, bad numbers', async () => {
    const text = [
      'Roll Number,Subject Code,Internal,External,Internal Max,External Max',
      'R001,CS103,40,50,50,50',                 // custom maxima
      'R002,CS103,x,10,,',                       // bad number (line 3)
      'R003,CS103,60,10,50,50',                  // exceeds internal_max (line 4)
      'R004,CS103,25,35,,',
    ].join('\n');
    const r = ok(await api('POST', `/classes/${S.A}/marks/import`, { as: S.inA, form: csvForm(text) }), 201);
    assert.equal(r.okRows, 2); assert.deepEqual(r.errorReport.map((e) => [e.row, e.field]), [[3, 'internal'], [4, 'internal']]);
    const m = (await pool.query('SELECT internal_max, external_max, source, verification_status FROM marks WHERE student_id = $1 AND subject_id = $2', [S.stu[0].user.id, S.subj.CS103])).rows[0];
    assert.deepEqual([Number(m.internal_max), Number(m.external_max), m.source, m.verification_status], [50, 50, 'csv_import', 'verified']);
    const bad = ok(await api('POST', `/classes/${S.A}/marks/import?dryRun=1`, { as: S.inA, form: csvForm('roll_number,subject_code,semester,internal,external\nR001,CS201,1,10,10\nR001,CS201,2,30,40\n') }));
    assert.equal(bad.okRows, 1); assert.equal(bad.errorReport[0].field, 'semester');
    assert.equal((await api('POST', `/classes/${S.A}/marks/import?dryRun=1`, { as: S.inB, form: csvForm('roll_number,subject_code,internal,external\nR001,CS101,1,1\n') })).status, 404);
  });

  // ================================================================ verification center
  it('verification center: queue → detail → verify / reject / correct; every decision is atomic, audited and notified', async () => {
    const [s1, s2, s3, s4] = S.stu;
    // submissions from the students' side
    const certFile = pdf('c1');
    S.cert1 = ok(await api('POST', '/student/certificates', { as: s1, form: certForm(certFile, 'Intro to SQL') }), 201).certificate;
    S.cert2 = ok(await api('POST', '/student/certificates', { as: s1, form: certForm(pdf('c2'), 'Fake Cert') }), 201).certificate;
    S.cert3 = ok(await api('POST', '/student/certificates', { as: s2, form: certForm(pdf('c3'), 'Hackathon') }), 201).certificate;
    S.proj = ok(await api('POST', '/student/portfolio', { as: s1, body: { type: 'project', title: 'Campus App', bullets: ['Built an API serving 2,000 users'], techStack: ['Node.js'] } }), 201).item;
    S.claim = ok(await api('POST', '/student/academics/claims', { as: s4, body: { subjectId: S.subj.CS102, internalObtained: 35, externalObtained: 50 } }), 201).claim;
    ok(await api('PATCH', '/student/profile', { as: s1, body: { gender: 'female', address: '12 Park Road' } }));

    const q = ok(await api('GET', `/classes/${S.A}/verifications`, { as: S.inA }));
    assert.equal(q.pendingTotal, q.items.length);
    for (const t of ['certificate', 'project', 'marks', 'profile']) assert.ok(q.pendingByType[t] >= 1, `queue has a ${t}`);
    const certItem = q.items.find((i) => i.entityId === S.cert1.id);
    assert.equal(certItem.summary.title, 'Intro to SQL'); assert.equal(certItem.student.rollNumber, 'R001');
    assert.equal(ok(await api('GET', `/classes/${S.A}/verifications?type=certificate&studentId=${s2.user.id}`, { as: S.inA })).items.length, 1);
    assert.equal(code(await api('GET', `/classes/${S.A}/verifications?type=nonsense`, { as: S.inA })), 'VALIDATION_ERROR');

    // evidence
    const d = ok(await api('GET', `/classes/${S.A}/verifications/${certItem.id}`, { as: S.inA }));
    assert.equal(d.item.title, 'Intro to SQL'); assert.equal(d.hasFile, true);
    assert.equal(d.item.file_path, undefined, 'storage paths never leave the server');
    const file = await api('GET', `/classes/${S.A}/verifications/${certItem.id}/file`, { as: S.inA });
    assert.equal(file.status, 200); assert.ok(file.raw.equals(certFile));
    assert.equal((await api('GET', `/classes/${S.A}/verifications/${certItem.id}/file`, { as: S.inB })).status, 404);

    // verify → certificate gets its public QR code and now counts
    assert.equal(ok(await api('POST', `/classes/${S.A}/verifications/${certItem.id}/verify`, { as: S.inA, body: { remarks: 'Checked on Coursera' } })).request.status, 'verified');
    const mine = ok(await api('GET', '/student/certificates', { as: s1 })).certificates.find((c) => c.id === S.cert1.id);
    assert.equal(mine.status, 'verified'); assert.match(mine.verificationCode, /^CRT-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const pub = ok(await api('GET', `/verify/${mine.verificationCode}`));
    assert.equal(pub.valid, true); assert.equal(pub.title, 'Intro to SQL');
    assert.ok(pub.verifiedBy, 'the verifier is named');

    // double decisions / missing remarks
    assert.equal(code(await api('POST', `/classes/${S.A}/verifications/${certItem.id}/reject`, { as: S.inA, body: { remarks: 'too late' } })), 'ALREADY_DECIDED');
    const fakeItem = q.items.find((i) => i.entityId === S.cert2.id);
    assert.equal(code(await api('POST', `/classes/${S.A}/verifications/${fakeItem.id}/reject`, { as: S.inA, body: {} })), 'VALIDATION_ERROR');
    assert.equal(code(await api('POST', `/classes/${S.A}/verifications/${fakeItem.id}/request-correction`, { as: S.inA, body: { remarks: 'a' } })), 'VALIDATION_ERROR');
    assert.equal((await api('POST', `/classes/${S.A}/verifications/${fakeItem.id}/verify`, { as: S.inB, body: {} })).status, 404, 'another instructor cannot decide it');

    ok(await api('POST', `/classes/${S.A}/verifications/${fakeItem.id}/reject`, { as: S.inA, body: { remarks: 'Not a genuine certificate' } }));
    assert.equal((await api('GET', `/verify/${(await pool.query('SELECT verification_code FROM certificates WHERE id=$1', [S.cert2.id])).rows[0].verification_code}`)).status, 404, 'rejected → never verifiable');
    const rej = ok(await api('GET', '/student/certificates', { as: s1 })).certificates.find((c) => c.id === S.cert2.id);
    assert.equal(rej.status, 'rejected'); assert.equal(rej.remarks, 'Not a genuine certificate');

    // request correction on the profile; student is notified and can resubmit
    const prof = q.items.find((i) => i.type === 'profile' && i.student.id === s1.user.id);
    ok(await api('POST', `/classes/${S.A}/verifications/${prof.id}/request-correction`, { as: S.inA, body: { remarks: 'Add your full address' } }));
    assert.equal((await pool.query('SELECT verification_status FROM student_profiles WHERE user_id = $1', [s1.user.id])).rows[0].verification_status, 'correction_requested');
    const notes = ok(await api('GET', '/notifications?unread=true', { as: s1 }));
    assert.ok(notes.notifications.some((n) => /correction/i.test(n.title)) && notes.notifications.some((n) => /Certificate verified/i.test(n.title)));
    ok(await api('POST', '/student/profile/submit', { as: s1 }));
    assert.ok(ok(await api('GET', `/classes/${S.A}/verifications`, { as: S.inA })).items.some((i) => i.type === 'profile' && i.student.id === s1.user.id), 'resubmission is queued again');

    // audit trail
    const audits = (await pool.query(`SELECT action FROM audit_logs WHERE class_id = $1 AND action LIKE 'certificate.%'`, [S.A])).rows.map((r) => r.action);
    assert.ok(audits.includes('certificate.verify') && audits.includes('certificate.reject'));
  });

  it('bulk verification: partial success is reported per item; verified marks claims start to count', async () => {
    const q = ok(await api('GET', `/classes/${S.A}/verifications?status=pending`, { as: S.inA }));
    const ids = q.items.filter((i) => ['project', 'marks', 'certificate'].includes(i.type)).map((i) => i.id);
    assert.ok(ids.length >= 3);
    const before = ok(await api('GET', '/student/academics', { as: S.stu[3] }));
    assert.equal(before.semesters.flatMap((s) => s.subjects).some((x) => x.code === 'CS102'), false, 'an unverified claim does not count');

    const res = ok(await api('POST', `/classes/${S.A}/verifications/bulk`, { as: S.inA, body: { ids: [...ids, ids[0], '00000000-0000-4000-8000-000000000000'], action: 'verify' } }));
    assert.equal(res.done, ids.length, 'duplicates are processed once');
    assert.equal(res.failed.length, 1); assert.equal(res.failed[0].code, 'NOT_FOUND');
    assert.equal(code(await api('POST', `/classes/${S.A}/verifications/bulk`, { as: S.inA, body: { ids: [ids[0]], action: 'reject' } })), 'VALIDATION_ERROR', 'bulk reject needs a reason');
    const again = ok(await api('POST', `/classes/${S.A}/verifications/bulk`, { as: S.inA, body: { ids: [ids[0]], action: 'verify' } }));
    assert.equal(again.done, 0); assert.equal(again.failed[0].code, 'ALREADY_DECIDED');
    assert.equal(code(await api('POST', `/classes/${S.A}/verifications/bulk`, { as: S.inA, body: { ids: [] } })), 'VALIDATION_ERROR');

    const after = ok(await api('GET', '/student/academics', { as: S.stu[3] }));
    assert.equal(after.semesters.flatMap((s) => s.subjects).some((x) => x.code === 'CS102'), true, 'verified claim now counts in the CGPA');
  });

  it('a request whose item the student deleted is reported as gone, not 500', async () => {
    const s2 = S.stu[1];
    const item = ok(await api('POST', '/student/portfolio', { as: s2, body: { type: 'project', title: 'To be deleted' } }), 201).item;
    // simulate a stale request: the item disappears without the request being withdrawn
    await pool.query('DELETE FROM portfolio_items WHERE id = $1', [item.id]);
    const stale = (await pool.query(`SELECT id FROM verification_requests WHERE entity_id = $1`, [item.id])).rows[0];
    if (stale) assert.equal(code(await api('POST', `/classes/${S.A}/verifications/${stale.id}/verify`, { as: S.inA, body: {} })), 'ITEM_GONE');
  });

  // ================================================================ analytics
  it('student roster and detail', async () => {
    const list = ok(await api('GET', `/classes/${S.A}/students`, { as: S.inA }));
    assert.equal(list.students.length, 4);
    const asha = list.students.find((s) => s.rollNumber === 'R001');
    assert.ok(asha.cgpa >= 9 && asha.attendancePct === 100 && asha.rank === 1, JSON.stringify(asha));
    assert.equal(ok(await api('GET', `/classes/${S.A}/students?q=bala`, { as: S.inA })).students.length, 1);
    assert.ok(list.students.some((s) => s.name === 'देव नायर'), 'non-Latin names round-trip (database is UTF-8)');
    assert.equal(ok(await api('GET', `/classes/${S.A}/students?q=R003`, { as: S.inA })).students.length, 1);

    const d = ok(await api('GET', `/classes/${S.A}/students/${S.stu[0].user.id}`, { as: S.inA }));
    assert.equal(d.student.name, 'Asha Rao'); assert.equal(d.rank.rank, 1); assert.equal(d.rank.of, 4);
    assert.ok(d.attendance.subjects.some((s) => s.code === 'CS101'));
    assert.ok(d.certificates.length >= 2 && d.academics.semesters.length >= 1);
    assert.equal(d.student.address, '12 Park Road', 'instructors see identity details');
    assert.equal(JSON.stringify(d).includes('password'), false);
    assert.equal((await api('GET', `/classes/${S.A}/students/${S.stuB.user.id}`, { as: S.inA })).status, 404, 'a student of another class is not visible');
    assert.equal((await api('GET', `/classes/${S.B}/students/${S.stu[0].user.id}`, { as: S.inB })).status, 404);

    assert.equal(ok(await api('PATCH', `/classes/${S.A}/students/${S.stu[3].user.id}`, { as: S.inA, body: { rollNumber: 'R104' } })).rollNumber, 'R104');
    assert.equal(code(await api('PATCH', `/classes/${S.A}/students/${S.stu[3].user.id}`, { as: S.inA, body: { rollNumber: 'R001' } })), 'ROLL_NUMBER_TAKEN');
    ok(await api('PATCH', `/classes/${S.A}/students/${S.stu[3].user.id}`, { as: S.inA, body: { rollNumber: 'R004' } }));
  });

  it('analytics: overview, subjects, performers, at-risk, skill gap, compare', async () => {
    const o = ok(await api('GET', `/classes/${S.A}/analytics/overview`, { as: S.inA }));
    assert.equal(o.students, 4);
    assert.ok(o.averages.cgpa > 0 && o.averages.attendancePct !== null);
    assert.equal(o.attendanceDistribution.reduce((a, b) => a + b.count, 0), 4, 'every student is in exactly one attendance bucket');
    const withCgpa = o.cgpaDistribution.reduce((a, b) => a + b.count, 0);
    assert.ok(withCgpa >= 1 && withCgpa <= 4, 'only students with verified marks are bucketed');
    assert.ok(o.belowAttendance >= 1, 'student 3 has 0% attendance');
    assert.ok(o.sgpaTrend.length >= 1 && o.certificates.verified >= 1);
    assert.equal(o.risk.low + o.risk.medium + o.risk.high + o.risk.unknown, 4);

    const sub = ok(await api('GET', `/classes/${S.A}/analytics/subjects?semester=1`, { as: S.inA }));
    const cs101 = sub.subjects.find((s) => s.code === 'CS101');
    assert.equal(cs101.students, 4); assert.ok(cs101.passPct === 100 || cs101.passPct === 75 || cs101.passPct > 0);
    assert.ok(cs101.attendancePct > 0 && cs101.avgPercentage > 0 && cs101.bestPercentage >= cs101.avgPercentage);

    const perf = ok(await api('GET', `/classes/${S.A}/analytics/performers?n=2`, { as: S.inA }));
    assert.equal(perf.top[0].rollNumber, 'R001'); assert.equal(perf.top.length, 2); assert.equal(perf.bottom.length, 2);
    assert.ok(!perf.top.some((t) => perf.bottom.some((b) => b.id === t.id)), 'top and bottom never overlap');

    const risk = ok(await api('GET', `/classes/${S.A}/analytics/at-risk`, { as: S.inA }));
    const s3 = risk.students.find((s) => s.rollNumber === 'R003');
    assert.ok(s3 && s3.reasons.some((r) => /Attendance 0%/.test(r)), JSON.stringify(risk));
    assert.ok(!risk.students.some((s) => s.rollNumber === 'R001'), 'a strong student is not flagged');

    const gap = ok(await api('GET', `/classes/${S.A}/analytics/skill-gap`, { as: S.inA }));
    assert.equal(gap.withoutTarget, 4); assert.deepEqual(gap.roles, []);
    const role = (await pool.query(`SELECT id FROM career_roles WHERE name = 'Web Developer'`)).rows[0].id;
    ok(await api('PUT', '/student/target-role', { as: S.stu[0], body: { roleId: role } }));
    ok(await api('PUT', '/student/target-role', { as: S.stu[1], body: { roleId: role } }));
    const gap2 = ok(await api('GET', `/classes/${S.A}/analytics/skill-gap`, { as: S.inA }));
    assert.equal(gap2.roles[0].role, 'Web Developer'); assert.equal(gap2.roles[0].students, 2); assert.ok(gap2.roles[0].mostMissing.length > 0);
    assert.equal(gap2.withoutTarget, 2);

    const cmp = ok(await api('GET', `/classes/${S.A}/compare?studentIds=${S.stu[0].user.id},${S.stu[2].user.id}`, { as: S.inA }));
    assert.equal(cmp.students.length, 2); assert.ok(cmp.students[0].cgpa > cmp.students[1].cgpa);
    assert.equal(code(await api('GET', `/classes/${S.A}/compare?studentIds=${S.stu[0].user.id}`, { as: S.inA })), 'VALIDATION_ERROR');
    assert.equal((await api('GET', `/classes/${S.A}/compare?studentIds=${S.stu[0].user.id},${S.stuB.user.id}`, { as: S.inA })).status, 404);
  });

  // ================================================================ leaderboard
  it('leaderboard weights: validated, per-class, change the ranking, shared with the student view, resettable', async () => {
    const lb = ok(await api('GET', `/classes/${S.A}/leaderboard`, { as: S.inA }));
    assert.equal(lb.weightsSource, 'default'); assert.equal(lb.weights.marks, 35);
    assert.equal(lb.board[0].rollNumber, 'R001'); assert.equal(lb.board[0].rank, 1);
    assert.ok(lb.board.every((b, i, a) => i === 0 || a[i - 1].score >= b.score), 'sorted by score');

    const W = { marks: 0, attendance: 0, certificates: 100, skills: 0, resume: 0, activity: 0 };
    assert.equal(code(await api('PUT', `/classes/${S.A}/leaderboard-config`, { as: S.inA, body: { ...W, certificates: 90 } })), 'VALIDATION_ERROR', 'must sum to 100');
    assert.equal(code(await api('PUT', `/classes/${S.A}/leaderboard-config`, { as: S.inA, body: { ...W, marks: -10, certificates: 110 } })), 'VALIDATION_ERROR');
    assert.equal(code(await api('PUT', `/classes/${S.A}/leaderboard-config`, { as: S.inA, body: { marks: 50.5, attendance: 49.5, certificates: 0, skills: 0, resume: 0, activity: 0 } })), 'VALIDATION_ERROR', 'integers only');
    assert.equal((await api('PUT', `/classes/${S.A}/leaderboard-config`, { as: S.inB, body: W })).status, 404);
    assert.equal(code(await api('PUT', `/classes/${S.A}/leaderboard-config`, { as: S.stu[0], body: W })), 'ROLE_FORBIDDEN');

    const cfg = ok(await api('PUT', `/classes/${S.A}/leaderboard-config`, { as: S.inA, body: W }));
    assert.equal(cfg.source, 'class'); assert.equal(cfg.weights.certificates, 100); assert.equal(cfg.defaults.marks, 35);
    const lb2 = ok(await api('GET', `/classes/${S.A}/leaderboard`, { as: S.inA }));
    assert.ok(lb2.board.every((b) => b.score === b.components.certificates), 'the score is exactly the certificate component');
    assert.ok(lb2.board.every((b, i, a) => i === 0 || a[i - 1].score >= b.score));
    assert.equal(lb2.board.filter((b) => b.score > 0).length, 2, 'two students have a verified certificate'); assert.equal(lb2.board[2].score, 0);
    const ashaRank = lb2.board.find((b) => b.rollNumber === 'R001').rank;
    const mine = ok(await api('GET', '/student/leaderboard', { as: S.stu[0] }));
    assert.equal(mine.weights.certificates, 100); assert.equal(mine.me.rank, ashaRank);
    // another class keeps the defaults
    assert.equal(ok(await api('GET', `/classes/${S.B}/leaderboard-config`, { as: S.inB })).source, 'default');

    ok(await api('DELETE', `/classes/${S.A}/leaderboard-config`, { as: S.inA }));
    assert.equal(ok(await api('GET', `/classes/${S.A}/leaderboard-config`, { as: S.inA })).weights.marks, 35);
    assert.equal(ok(await api('GET', `/classes/${S.A}/leaderboard?semester=1`, { as: S.inA })).semester, 1);
  });

  // ================================================================ class life
  it('announcements: create → notify every student; pin; delete', async () => {
    const a = ok(await api('POST', `/classes/${S.A}/announcements`, { as: S.inA, body: { title: 'Mid-term schedule', body: 'Exams start Monday.', pinned: true } }), 201).announcement;
    for (const s of S.stu.slice(0, 3)) {
      const n = ok(await api('GET', '/notifications?unread=true', { as: s }));
      assert.ok(n.notifications.some((x) => x.title === 'Mid-term schedule'), 'notified');
    }
    assert.ok(ok(await api('GET', '/student/announcements', { as: S.stu[0] })).announcements.some((x) => x.title === 'Mid-term schedule'));
    assert.equal(ok(await api('GET', '/notifications?unread=true', { as: S.stuB })).notifications.some((x) => x.title === 'Mid-term schedule'), false, 'other classes are not notified');
    assert.equal(code(await api('POST', `/classes/${S.A}/announcements`, { as: S.inA, body: { title: 'x', body: 'y' } })), 'VALIDATION_ERROR');
    assert.equal(ok(await api('PATCH', `/classes/${S.A}/announcements/${a.id}`, { as: S.inA, body: { pinned: false } })).pinned, false);
    assert.equal((await api('DELETE', `/classes/${S.A}/announcements/${a.id}`, { as: S.inB })).status, 404);
    assert.equal((await api('DELETE', `/classes/${S.A}/announcements/${a.id}`, { as: S.inA })).status, 204);
    assert.equal(ok(await api('GET', `/classes/${S.A}/announcements`, { as: S.inA })).announcements.length, 0);
  });

  it('activities: draft is invisible → publish notifies → participants (winner) lift the activity score; unpublish hides', async () => {
    const start = new Date(Date.now() + 3 * 86400000).toISOString();
    const act = ok(await api('POST', `/classes/${S.A}/activities`, { as: S.inA, body: { type: 'competition', title: 'Code Sprint', startsAt: start, venue: 'Lab 2' } }), 201).activity;
    assert.equal(act.published, false);
    assert.equal(ok(await api('GET', '/student/activities', { as: S.stu[0] })).activities.some((x) => x.title === 'Code Sprint'), false, 'drafts are hidden');
    assert.equal(code(await api('POST', `/classes/${S.A}/activities`, { as: S.inA, body: { type: 'event', title: 'Bad dates', startsAt: start, endsAt: new Date(Date.now()).toISOString() } })), 'VALIDATION_ERROR');

    ok(await api('POST', `/classes/${S.A}/activities/${act.id}/publish`, { as: S.inA }));
    assert.equal(code(await api('POST', `/classes/${S.A}/activities/${act.id}/publish`, { as: S.inA })), 'INVALID_STATE');
    assert.ok(ok(await api('GET', '/student/activities', { as: S.stu[0] })).activities.some((x) => x.title === 'Code Sprint'));
    assert.ok(ok(await api('GET', '/notifications?unread=true', { as: S.stu[1] })).notifications.some((x) => /Code Sprint/.test(x.title)));
    assert.equal((await api('POST', `/student/activities/${act.id}/register`, { as: S.stuB })).status, 404, 'a student of another class cannot register');
    ok(await api('POST', `/student/activities/${act.id}/register`, { as: S.stu[0] }), 201);

    const before = ok(await api('GET', `/classes/${S.A}/leaderboard`, { as: S.inA })).board.find((b) => b.rollNumber === 'R001').components.activity;
    ok(await api('PUT', `/classes/${S.A}/activities/${act.id}/participants`, { as: S.inA, body: { entries: [{ studentId: S.stu[0].user.id, status: 'winner', remarks: '1st place' }, { studentId: S.stu[1].user.id, status: 'attended' }] } }));
    const after = ok(await api('GET', `/classes/${S.A}/leaderboard`, { as: S.inA })).board.find((b) => b.rollNumber === 'R001').components.activity;
    assert.ok(after > before, `activity score rises (${before} → ${after})`);
    const parts = ok(await api('GET', `/classes/${S.A}/activities/${act.id}/participants`, { as: S.inA }));
    assert.equal(parts.participants.find((p) => p.rollNumber === 'R001').status, 'winner'); assert.equal(parts.participants.find((p) => p.rollNumber === 'R003').status, null);
    assert.equal(code(await api('PUT', `/classes/${S.A}/activities/${act.id}/participants`, { as: S.inA, body: { entries: [{ studentId: S.stuB.user.id, status: 'winner' }] } })), 'INVALID_STUDENT');
    assert.equal(ok(await api('GET', `/classes/${S.A}/activities`, { as: S.inA })).activities[0].attended, 2);

    ok(await api('POST', `/classes/${S.A}/activities/${act.id}/unpublish`, { as: S.inA }));
    assert.equal(ok(await api('GET', '/student/activities', { as: S.stu[0] })).activities.some((x) => x.title === 'Code Sprint'), false);
    assert.equal(ok(await api('PATCH', `/classes/${S.A}/activities/${act.id}`, { as: S.inA, body: { title: 'Code Sprint 2', venue: null } })).activity.title, 'Code Sprint 2');
    assert.equal((await api('DELETE', `/classes/${S.A}/activities/${act.id}`, { as: S.inB })).status, 404);
    assert.equal((await api('DELETE', `/classes/${S.A}/activities/${act.id}`, { as: S.inA })).status, 204);
  });

  it('assignments: create → students notified and see it; submissions tracker; remarks; foreign subject rejected', async () => {
    const due = new Date(Date.now() + 5 * 86400000).toISOString();
    const a = ok(await api('POST', `/classes/${S.A}/assignments`, { as: S.inA, body: { title: 'Lab record', dueAt: due, subjectId: S.subj.CS101, description: 'Complete experiments 1-5' } }), 201).assignment;
    assert.ok(ok(await api('GET', '/student/assignments', { as: S.stu[0] })).assignments.some((x) => x.title === 'Lab record'));
    assert.equal(code(await api('POST', `/classes/${S.A}/assignments`, { as: S.inA, body: { title: 'Bad subject', dueAt: due, subjectId: '00000000-0000-4000-8000-000000000000' } })), 'INVALID_SUBJECT');
    ok(await api('POST', `/student/assignments/${a.id}/submit`, { as: S.stu[0] }));
    const subs = ok(await api('GET', `/classes/${S.A}/assignments/${a.id}/submissions`, { as: S.inA }));
    assert.equal(subs.submissions[0].rollNumber, 'R001', 'submitted first'); assert.ok(subs.submissions[0].submittedAt); assert.equal(subs.submissions[3].submittedAt, null);
    ok(await api('PUT', `/classes/${S.A}/assignments/${a.id}/submissions/${S.stu[0].user.id}`, { as: S.inA, body: { remarks: 'Well done' } }));
    assert.equal(ok(await api('GET', `/classes/${S.A}/assignments`, { as: S.inA })).assignments[0].submitted, 1);
    assert.equal((await api('PUT', `/classes/${S.A}/assignments/${a.id}/submissions/${S.stuB.user.id}`, { as: S.inA, body: { remarks: 'x' } })).status, 404);
    assert.equal(ok(await api('PATCH', `/classes/${S.A}/assignments/${a.id}`, { as: S.inA, body: { title: 'Lab record v2', description: null } })).assignment.title, 'Lab record v2');
    assert.equal((await api('DELETE', `/classes/${S.A}/assignments/${a.id}`, { as: S.inA })).status, 204);
  });

  it('mentoring notes, parent notices, audit log', async () => {
    const s3 = S.stu[2];
    const n = ok(await api('POST', `/classes/${S.A}/students/${s3.user.id}/notes`, { as: S.inA, body: { note: 'Met after class; family issues.' } }), 201).note;
    assert.equal(ok(await api('GET', `/classes/${S.A}/students/${s3.user.id}`, { as: S.inA })).notes.length, 1);
    assert.equal((await api('POST', `/classes/${S.A}/students/${S.stuB.user.id}/notes`, { as: S.inA, body: { note: 'nope nope' } })).status, 404);
    assert.equal((await api('DELETE', `/classes/${S.A}/students/${s3.user.id}/notes/${n.id}`, { as: S.inB })).status, 404);
    assert.equal((await api('DELETE', `/classes/${S.A}/students/${s3.user.id}/notes/${n.id}`, { as: S.inA })).status, 204);

    ok(await api('PATCH', '/student/profile', { as: s3, body: { guardianName: 'Parent', guardianEmail: 'parent@test.example' } }));
    const sent = ok(await api('POST', `/classes/${S.A}/parent-notifications`, { as: S.inA, body: { studentIds: [s3.user.id, S.stu[0].user.id], channel: 'email', reason: 'low_attendance', message: 'Attendance is below 75%.' } }), 201);
    assert.equal(sent.queued, 1); assert.equal(sent.failed, 1); assert.match(sent.results.find((r) => r.status === 'failed').problem, /No guardian/);
    assert.equal(code(await api('POST', `/classes/${S.A}/parent-notifications`, { as: S.inA, body: { studentIds: [S.stuB.user.id], channel: 'sms', reason: 'custom', message: 'hello there' } })), 'INVALID_STUDENT');
    assert.equal(ok(await api('GET', `/classes/${S.A}/parent-notifications`, { as: S.inA })).notifications.length, 2);

    const log = ok(await api('GET', `/classes/${S.A}/audit-logs?limit=5`, { as: S.inA }));
    assert.equal(log.logs.length, 5); assert.ok(log.nextBefore);
    const page2 = ok(await api('GET', `/classes/${S.A}/audit-logs?limit=5&before=${log.nextBefore}`, { as: S.inA }));
    assert.ok(page2.logs.every((l) => l.id < log.nextBefore));
    const marks = ok(await api('GET', `/classes/${S.A}/audit-logs?action=marks&limit=50`, { as: S.inA }));
    assert.ok(marks.logs.length >= 1 && marks.logs.every((l) => l.action.startsWith('marks')));
    assert.ok(log.logs[0].actor, 'actor name is included');
    assert.equal((await api('GET', `/classes/${S.A}/audit-logs`, { as: S.inB })).status, 404);
    // class B's log never contains class A events
    assert.equal(ok(await api('GET', `/classes/${S.B}/audit-logs?limit=200`, { as: S.inB })).logs.some((l) => l.action.startsWith('marks')), false);
  });

  // ================================================================ exports
  it('CSV exports: correct columns, formula injection neutralised, audited, class-scoped', async () => {
    for (const kind of ['students', 'leaderboard', 'attendance', 'marks']) {
      const r = await api('GET', `/classes/${S.A}/export/${kind}`, { as: S.inA });
      assert.equal(r.status, 200, kind); assert.match(r.headers.get('content-type'), /text\/csv/); assert.match(r.headers.get('content-disposition'), /attachment/);
    }
    const students = (await api('GET', `/classes/${S.A}/export/students`, { as: S.inA })).body;
    assert.ok(students.startsWith('roll_number,name,email,rank,score,cgpa'));
    assert.ok(students.includes("'=SUM(1+1) Evil"), 'a name that starts with "=" is stored as text, not a formula');
    assert.equal(/(^|,)=SUM/m.test(students), false);
    assert.ok(students.includes('Asha Rao'));
    assert.equal(students.includes('Other Class'), false, 'no student of another class');
    const att = (await api('GET', `/classes/${S.A}/export/attendance`, { as: S.inA })).body;
    assert.ok(att.split('\r\n').length > 4 && att.includes('CS101'));
    assert.equal(code(await api('GET', `/classes/${S.A}/export/passwords`, { as: S.inA })), 'VALIDATION_ERROR');
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE class_id = $1 AND action = 'report.export'`, [S.A])).rowCount >= 4);
  });

  // ================================================================ subjects are protected once used
  it('a subject with marks or attendance cannot be deleted or moved; an unused one can', async () => {
    assert.equal(code(await api('DELETE', `/classes/${S.A}/subjects/${S.subj.CS101}`, { as: S.inA })), 'SUBJECT_IN_USE');
    assert.equal(code(await api('PATCH', `/classes/${S.A}/subjects/${S.subj.CS101}`, { as: S.inA, body: { semester: 3 } })), 'SUBJECT_IN_USE');
    assert.equal(ok(await api('PATCH', `/classes/${S.A}/subjects/${S.subj.CS101}`, { as: S.inA, body: { name: 'Programming Basics' } })).subject.name, 'Programming Basics', 'renaming is fine');
    assert.equal((await api('DELETE', `/classes/${S.A}/subjects/${S.subj.CS201}`, { as: S.inB })).status, 404);
    assert.equal((await api('DELETE', `/classes/${S.A}/subjects/${S.subj.CS201}`, { as: S.inA })).status, 204);
    assert.equal((await api('DELETE', `/classes/${S.A}/subjects/${S.subj.CS201}`, { as: S.inA })).status, 404);
  });
});
