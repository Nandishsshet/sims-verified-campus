'use strict';
/**
 * Student-side flows against a REAL PostgreSQL (Phase 3):
 * pending state → approval hook, attendance, academics, certificates (upload / dedupe / magic bytes / QR),
 * portfolio, skills + skill-gap + roadmap, resume (ATS, AI fallback), dashboard, leaderboard privacy,
 * verification status, notifications, leaving a class.
 *
 * Run with:  npm run test:integration
 */
require('../helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SKIP = !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL (or use `npm run test:integration`)';

describe('SIMS student flows', { skip: SKIP }, () => {
  let server; let base; let pool;
  const run = `s${Date.now().toString(36)}`;
  const PW = 'Passw0rd!x';
  let ipCounter = 0;
  const nextIp = () => `10.60.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  async function api(method, path, { as, body, form } = {}) {
    const headers = { 'x-forwarded-for': as?.ip || nextIp() };
    if (as?.token) headers.authorization = `Bearer ${as.token}`;
    if (!form) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const ct = res.headers.get('content-type') || '';
    const raw = await res.arrayBuffer();
    const text = Buffer.from(raw).toString('utf8');
    return { status: res.status, headers: res.headers, raw: Buffer.from(raw), body: ct.includes('json') && text ? JSON.parse(text) : text };
  }
  const code = (r) => r.body?.error?.code;
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

  async function signup(kind, extra, label) {
    const r = await api('POST', `/auth/signup/${kind}`, { body: { fullName: `Test ${label}`, email: `${label}.${run}@test.example`, password: PW, ...extra } });
    assert.equal(r.status, 201, `signup ${label}: ${JSON.stringify(r.body)}`);
    return { token: r.body.accessToken, user: r.body.user, ip: nextIp(), res: r.body };
  }

  const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ${tag} ${run} ${Math.random()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function certForm({ file, name = 'cert.pdf', type = 'application/pdf', ...fields }) {
    const f = new FormData();
    for (const [k, v] of Object.entries({ title: 'Intro to Databases', category: 'course', issuer: 'Coursera', issueDate: '2025-01-15', ...fields })) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    f.append('file', new Blob([file], { type }), name);
    return f;
  }

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

  const S = {};
  const skillId = async (name) => (await pool.query('SELECT id FROM skills WHERE name = $1', [name])).rows[0].id;

  // ================================================================ hierarchy + students
  it('builds university → college → instructor → class and three students', async () => {
    const uh = await signup('university-head', { university: { name: `Uni ${run}` } }, 'uh');
    const ca = await signup('college-admin', { universityKey: uh.res.universityKey, college: { name: `College ${run}`, principalName: 'Dr P' } }, 'ca');
    const approved = ok(await api('POST', `/university/colleges/${ca.res.college.id}/approve`, { as: uh }));
    const dept = ok(await api('POST', '/college/departments', { as: ca, body: { name: 'Computer Science', code: 'cse', hodName: 'Dr H' } }), 201);
    S.in1 = await signup('instructor', { collegeKey: approved.collegeKey }, 'in1');
    const m = ok(await api('GET', '/college/instructors?status=pending', { as: ca })).instructors[0].id;
    ok(await api('POST', `/college/instructors/${m}/approve`, { as: ca }));
    const cls = ok(await api('POST', '/classes', { as: S.in1, body: { departmentId: dept.department.id, branch: 'CSE', admissionYear: 2023, passoutYear: 2027 } }), 201);
    S.classId = cls.class.id; S.classKey = cls.classKey; S.collegeId = ca.res.college.id; S.uh = uh; S.ca = ca;

    S.s1 = await signup('student', {}, 's1');
    S.s2 = await signup('student', {}, 's2');
    S.s3 = await signup('student', {}, 's3');
  });

  // ================================================================ pending state
  it('a student with no class sees a limited dashboard and cannot use class features', async () => {
    assert.equal(ok(await api('GET', '/student/dashboard', { as: S.s1 })).state, 'no_class');
    assert.equal(code(await api('GET', '/student/certificates', { as: S.s1 })), 'NO_CLASS');
    assert.equal(code(await api('GET', '/student/attendance', { as: S.s1 })), 'NO_CLASS');
    assert.equal(code(await api('GET', '/student/dashboard', { as: S.in1 })), 'ROLE_FORBIDDEN');
    assert.equal((await api('GET', '/student/dashboard')).status, 401);
  });

  it('a pending student can edit their profile; approval then queues it for verification', async () => {
    const j2 = ok(await api('POST', '/join/class', { as: S.s2, body: { classKey: S.classKey, rollNumber: 'R002' } }), 201);
    S.enroll2 = j2.enrollmentId;
    const dash = ok(await api('GET', '/student/dashboard', { as: S.s2 }));
    assert.equal(dash.state, 'pending'); assert.ok(dash.pendingClass.name);

    ok(await api('PATCH', '/student/profile', { as: S.s2, body: { dateOfBirth: '2005-04-02', gender: 'female', summary: 'Keen learner' } }));
    assert.equal((await pool.query(`SELECT 1 FROM verification_requests WHERE entity_type = 'profile' AND student_id = $1`, [S.s2.user.id])).rowCount, 0, 'nothing queued before approval');

    ok(await api('POST', `/classes/${S.classId}/enrollments/${S.enroll2}/approve`, { as: S.in1, body: {} }));
    const q = await pool.query(`SELECT status FROM verification_requests WHERE entity_type = 'profile' AND entity_id = $1`, [S.s2.user.id]);
    assert.equal(q.rows.length, 1); assert.equal(q.rows[0].status, 'pending');
    const note = await api('GET', '/notifications?unread=true', { as: S.s2 });
    assert.ok(note.body.unread >= 1);
    assert.equal(ok(await api('GET', '/student/dashboard', { as: S.s2 })).state, 'approved');
  });

  it('profile validation: future DOB and empty patch are rejected; photo magic bytes enforced', async () => {
    assert.equal(code(await api('PATCH', '/student/profile', { as: S.s2, body: { dateOfBirth: '2999-01-01' } })), 'VALIDATION_ERROR');
    assert.equal(code(await api('PATCH', '/student/profile', { as: S.s2, body: {} })), 'VALIDATION_ERROR');
    const bad = new FormData(); bad.append('file', new Blob([Buffer.from('<?php echo 1;')], { type: 'image/png' }), 'x.png');
    assert.equal(code(await api('POST', '/student/profile/photo', { as: S.s2, form: bad })), 'INVALID_FILE_TYPE');
    const good = new FormData(); good.append('file', new Blob([Buffer.concat([PNG_HEAD, Buffer.alloc(64, 1)])], { type: 'image/png' }), 'me.png');
    ok(await api('POST', '/student/profile/photo', { as: S.s2, form: good }), 201);
    const got = await api('GET', '/student/profile/photo', { as: S.s2 });
    assert.equal(got.status, 200); assert.ok(got.raw.subarray(0, 8).equals(PNG_HEAD));
  });

  // ================================================================ s1 joins and gets data
  it('s1 joins and is approved; instructor-side data is inserted as verified', async () => {
    const j = ok(await api('POST', '/join/class', { as: S.s1, body: { classKey: S.classKey, rollNumber: 'R001' } }), 201);
    ok(await api('POST', `/classes/${S.classId}/enrollments/${j.enrollmentId}/approve`, { as: S.in1, body: {} }));
    const j3 = ok(await api('POST', '/join/class', { as: S.s3, body: { classKey: S.classKey, rollNumber: 'R003' } }), 201);
    ok(await api('POST', `/classes/${S.classId}/enrollments/${j3.enrollmentId}/approve`, { as: S.in1, body: {} }));

    S.subj = {};
    for (const [code_, name, credits] of [['CS101', 'Programming', 4], ['CS102', 'Mathematics', 4], ['CS103', 'Physics', 3]]) {
      S.subj[code_] = (await pool.query('INSERT INTO subjects (class_id, semester, code, name, credits) VALUES ($1,1,$2,$3,$4) RETURNING id', [S.classId, code_, name, credits])).rows[0].id;
    }
    // attendance (verified, instructor): s1 → CS101 20/20, CS102 14/20 (70%), CS103 18/20 ; s2 → 10/20 everywhere
    const att = async (student, subject, held, present) => pool.query(
      `INSERT INTO attendance_records (class_id, student_id, subject_id, attendance_date, period, status)
       SELECT $1, $2, $3, (current_date - 60 + g), 1, CASE WHEN g <= $5 THEN 'present'::attendance_status ELSE 'absent'::attendance_status END FROM generate_series(1, $4) g`,
      [S.classId, student, subject, held, present]);
    await att(S.s1.user.id, S.subj.CS101, 20, 20); await att(S.s1.user.id, S.subj.CS102, 20, 14); await att(S.s1.user.id, S.subj.CS103, 20, 18);
    for (const k of Object.keys(S.subj)) await att(S.s2.user.id, S.subj[k], 20, 10);

    // marks: s1 strong (CS102 failed → backlog), s2 average
    const mark = (student, subject, i, e) => pool.query(
      `INSERT INTO marks (student_id, subject_id, semester, internal_obtained, external_obtained, grade, grade_points, is_pass)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7)`, [student, subject, i, e, ...(i + e >= 40 ? (i + e >= 90 ? ['O', 10, true] : ['B', 7, true]) : ['F', 0, false])]);
    await mark(S.s1.user.id, S.subj.CS101, 38, 58); await mark(S.s1.user.id, S.subj.CS102, 10, 20); await mark(S.s1.user.id, S.subj.CS103, 30, 45);
    for (const k of Object.keys(S.subj)) await mark(S.s2.user.id, S.subj[k], 28, 40);
  });

  // ================================================================ attendance
  it('attendance: verified-only stats, per-subject alerts, can-miss calculator', async () => {
    const a = ok(await api('GET', '/student/attendance', { as: S.s1 }));
    assert.equal(a.overall.held, 60); assert.equal(a.overall.attended, 52);
    const cs102 = a.subjects.find((s) => s.code === 'CS102');
    assert.equal(cs102.percentage, 70); assert.ok(cs102.alert, '70% < 75% threshold');
    assert.equal(cs102.toRecover, 4, '14/20 → needs 4 consecutive classes to reach 75% (18/24)');
    assert.equal(a.subjects.find((s) => s.code === 'CS101').alert, false);
    assert.ok(a.subjects.find((s) => s.code === 'CS101').canMiss > 0);

    // 18/20 now, 10 classes left, 75% target: need 22.5 of 30 → attend ≥5 of the 10 → may miss 5
    const cm = ok(await api('GET', '/student/attendance/can-miss?attended=18&held=20&remaining=10', { as: S.s1 }));
    assert.equal(cm.missableOfRemaining, 5);
    // impossible target → null rather than a negative number
    const imp = ok(await api('GET', '/student/attendance/can-miss?attended=0&held=20&remaining=5', { as: S.s1 }));
    assert.equal(imp.missableOfRemaining, null);
  });

  it('attendance claims are pending, queue for the instructor and are excluded from stats; duplicates → 409', async () => {
    const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const c = ok(await api('POST', '/student/attendance/claims', { as: S.s1, body: { subjectId: S.subj.CS102, date: day, period: 3, note: 'Lab session, not marked' } }), 201);
    assert.equal(c.claim.verification_status, 'pending');
    assert.equal(ok(await api('GET', '/student/attendance', { as: S.s1 })).overall.held, 60, 'pending claims do not count');
    assert.equal(code(await api('POST', '/student/attendance/claims', { as: S.s1, body: { subjectId: S.subj.CS102, date: day, period: 3, note: 'again please' } })), 'RECORD_EXISTS');
    assert.equal(code(await api('POST', '/student/attendance/claims', { as: S.s1, body: { subjectId: S.subj.CS102, date: '2999-01-01', note: 'future' } })), 'FUTURE_DATE');
    assert.equal(code(await api('POST', '/student/attendance/claims', { as: S.s1, body: { subjectId: '00000000-0000-4000-8000-000000000000', date: day, note: 'unknown subject' } })), 'INVALID_SUBJECT');
    assert.equal((await pool.query(`SELECT 1 FROM verification_requests WHERE entity_type='attendance' AND student_id=$1 AND status='pending'`, [S.s1.user.id])).rowCount, 1);
  });

  // ================================================================ academics
  it('academics: SGPA/CGPA/backlogs from verified marks; predictor; claims for a passed subject blocked', async () => {
    const a = ok(await api('GET', '/student/academics', { as: S.s1 }));
    assert.equal(a.activeBacklogs.length, 1); assert.equal(a.activeBacklogs[0].code, 'CS102');
    assert.ok(a.cgpa > 0 && a.cgpa <= 10);
    assert.equal(a.semesters.length, 1);

    const p = ok(await api('GET', '/student/academics/predict?targetCgpa=8&nextCredits=24', { as: S.s1 }));
    assert.ok('requiredSgpa' in p || 'highestPossibleCgpa' in p, JSON.stringify(p));

    assert.equal(code(await api('POST', '/student/academics/claims', { as: S.s1, body: { subjectId: S.subj.CS101, internalObtained: 30, externalObtained: 40 } })), 'RECORD_EXISTS');
    assert.equal(code(await api('POST', '/student/academics/claims', { as: S.s1, body: { subjectId: S.subj.CS101, internalObtained: 99, externalObtained: 40 } })), 'VALIDATION_ERROR');
  });

  it('a failed subject can be re-attempted (attempt 2, pending) and the claim can be corrected', async () => {
    const c = ok(await api('POST', '/student/academics/claims', { as: S.s1, body: { subjectId: S.subj.CS102, internalObtained: 30, externalObtained: 45 } }), 201);
    assert.equal(c.claim.attempt, 2); assert.equal(c.claim.status, 'pending');
    assert.equal(ok(await api('GET', '/student/academics', { as: S.s1 })).activeBacklogs.length, 1, 'unverified re-attempt does not clear the backlog');
    ok(await api('PATCH', `/student/academics/claims/${c.claim.id}`, { as: S.s1, body: { internalObtained: 32, externalObtained: 46 } }));
    // instructor verifies it → backlog cleared
    await pool.query(`UPDATE marks SET verification_status = 'verified' WHERE id = $1`, [c.claim.id]);
    assert.equal(ok(await api('GET', '/student/academics', { as: S.s1 })).activeBacklogs.length, 0);
    assert.equal(code(await api('PATCH', `/student/academics/claims/${c.claim.id}`, { as: S.s1, body: { internalObtained: 10, externalObtained: 10 } })), 'NOT_FOUND', 'verified claims are locked');
  });

  // ================================================================ certificates
  it('certificates: upload → pending + queued; file rules; duplicate detection; owner-only download', async () => {
    const file = pdf('cert-1');
    const up = ok(await api('POST', '/student/certificates', { as: S.s1, form: certForm({ file, skills: [{ skillId: await skillId('SQL'), proficiency: 3 }] }) }), 201);
    S.cert = up.certificate;
    assert.equal(S.cert.status, 'pending'); assert.ok(S.cert.verificationCode == null, 'no QR code until verified');
    assert.equal((await pool.query(`SELECT 1 FROM verification_requests WHERE entity_type='certificate' AND entity_id=$1 AND status='pending'`, [S.cert.id])).rowCount, 1);

    assert.equal(code(await api('POST', '/student/certificates', { as: S.s1, form: certForm({ file }) })), 'DUPLICATE_CERTIFICATE');
    const fake = certForm({ file: Buffer.from('MZ\x90\x00 definitely not a pdf'), name: 'evil.pdf' });
    assert.equal(code(await api('POST', '/student/certificates', { as: S.s1, form: fake })), 'INVALID_FILE_TYPE');
    const big = certForm({ file: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 10, 65)]) });
    assert.equal(code(await api('POST', '/student/certificates', { as: S.s1, form: big })), 'FILE_TOO_LARGE');
    const noFile = new FormData(); noFile.append('title', 'x'); noFile.append('category', 'course'); noFile.append('issuer', 'y');
    assert.equal((await api('POST', '/student/certificates', { as: S.s1, form: noFile })).status, 400);

    const dl = await api('GET', `/student/certificates/${S.cert.id}/file`, { as: S.s1 });
    assert.equal(dl.status, 200); assert.ok(dl.raw.equals(file));
    assert.equal((await api('GET', `/student/certificates/${S.cert.id}/file`, { as: S.s2 })).status, 404, 'other students cannot download');
    assert.equal((await api('GET', `/student/certificates/${S.cert.id}/file`)).status, 401);
  });

  it('QR verification is public and only works once the certificate is verified; editing hides it again', async () => {
    const code0 = (await pool.query('SELECT verification_code FROM certificates WHERE id = $1', [S.cert.id])).rows[0].verification_code;
    assert.equal((await api('GET', `/verify/${code0 || 'CRT-AAAAA-BBBBB'}`)).status, 404, 'pending certificate is not verifiable');

    await pool.query(`UPDATE certificates SET verification_status='verified', verified_by=$2, verified_at=now(), verification_code = COALESCE(verification_code, 'CRT-ABCDE-FGHJK') WHERE id=$1`, [S.cert.id, S.in1.user.id]);
    const list = ok(await api('GET', '/student/certificates', { as: S.s1 }));
    const c = list.certificates.find((x) => x.id === S.cert.id);
    assert.match(c.verificationCode, /^CRT-[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const pub = await api('GET', `/verify/${c.verificationCode.toLowerCase()}`);        // no auth, no cookies
    assert.equal(pub.status, 200); assert.equal(pub.body.valid, true);
    assert.equal(pub.body.title, 'Intro to Databases'); assert.ok(pub.body.holder);
    for (const leaked of ['email', 'phone', 'file_path', 'filePath', 'studentId', 'id']) assert.equal(pub.body[leaked], undefined, `public response must not expose ${leaked}`);
    assert.equal((await api('GET', '/verify/not-a-code')).status, 404);

    ok(await api('PATCH', `/student/certificates/${S.cert.id}`, { as: S.s1, body: { issuer: 'Coursera Inc' } }));
    assert.equal((await api('GET', `/verify/${c.verificationCode}`)).status, 404, 'edit resets verification → QR stops validating');
    await pool.query(`UPDATE certificates SET verification_status='verified' WHERE id=$1`, [S.cert.id]);   // back for later tests
  });

  // ================================================================ portfolio
  it('portfolio: projects with skills; patch does not reset omitted lists; edits re-queue', async () => {
    const created = ok(await api('POST', '/student/portfolio', { as: S.s1, body: {
      type: 'project', title: 'Campus Connect', role: 'Lead', description: 'Student portal',
      bullets: ['Built REST API serving 2,000 users', 'Cut load time by 40%'], techStack: ['Node.js', 'React'],
      startDate: '2025-01-01', endDate: '2025-04-01', skills: [{ skillId: await skillId('Node.js'), proficiency: 3 }] } }), 201);
    S.project = created.item;
    assert.equal(S.project.status, 'pending');
    assert.equal(code(await api('POST', '/student/portfolio', { as: S.s1, body: { type: 'project', title: 'Bad', startDate: '2025-05-01', endDate: '2025-01-01' } })), 'VALIDATION_ERROR');
    assert.equal(code(await api('POST', '/student/portfolio', { as: S.s1, body: { type: 'project', title: 'Bad link', url: 'javascript:alert(1)' } })), 'VALIDATION_ERROR');

    const patched = ok(await api('PATCH', `/student/portfolio/${S.project.id}`, { as: S.s1, body: { title: 'Campus Connect v2' } }));
    assert.equal(patched.item.title, 'Campus Connect v2');
    assert.deepEqual(patched.item.bullets, S.project.bullets, 'omitted fields keep their value');
    assert.equal(patched.item.skills.length, 1);
    assert.equal(code(await api('PATCH', `/student/portfolio/${S.project.id}`, { as: S.s1, body: {} })), 'VALIDATION_ERROR');
    assert.equal((await api('PATCH', `/student/portfolio/${S.project.id}`, { as: S.s2, body: { title: 'hijack' } })).status, 404);

    await pool.query(`UPDATE portfolio_items SET verification_status='verified' WHERE id=$1`, [S.project.id]);
    const items = ok(await api('GET', '/student/portfolio?type=project', { as: S.s1 }));
    assert.equal(items.items.length, 1);
  });

  // ================================================================ skills, gap, roadmap
  it('skills catalogue and career roles are readable; target role + gap uses verified vs declared skills', async () => {
    const roles = ok(await api('GET', '/career-roles', { as: S.s1 })).roles;
    assert.ok(roles.length >= 6);
    const web = roles.find((r) => r.name === 'Web Developer');
    const detail = ok(await api('GET', `/career-roles/${web.id}`, { as: S.s1 }));
    assert.ok(detail.requirements.length >= 5);

    ok(await api('PUT', '/student/target-role', { as: S.s1, body: { roleId: web.id } }));
    assert.equal(code(await api('PUT', '/student/target-role', { as: S.s1, body: { roleId: '00000000-0000-4000-8000-000000000000' } })), 'INVALID_ROLE');

    const before = ok(await api('GET', '/student/skill-gap', { as: S.s1 }));
    const jsId = await skillId('JavaScript');
    const added = ok(await api('POST', '/student/skills', { as: S.s1, body: { skillId: jsId, proficiency: 4 } }), 201);
    assert.equal(code(await api('POST', '/student/skills', { as: S.s1, body: { skillId: jsId, proficiency: 2 } })), 'SKILL_EXISTS');
    const after1 = ok(await api('GET', '/student/skill-gap', { as: S.s1 }));
    assert.ok(after1.gapPct < before.gapPct, 'declared skill reduces the displayed gap');
    assert.equal(after1.verifiedGapPct, before.verifiedGapPct, 'but a self-declared skill does not reduce the VERIFIED gap');
    assert.ok(after1.radar.length >= 5);

    const skills = ok(await api('GET', '/student/skills', { as: S.s1 })).skills;
    assert.ok(skills.find((s) => s.name === 'JavaScript').selfDeclared);
    assert.ok(skills.find((s) => s.name === 'SQL').verified, 'skill evidenced by the verified certificate counts as verified');
    assert.equal(ok(await api('PATCH', `/student/skills/${added.skill.id}`, { as: S.s1, body: { proficiency: 5 } })).skill.proficiency, 5);

    const rm = ok(await api('GET', '/student/skill-gap/roadmap?hoursPerWeek=8', { as: S.s1 }));
    assert.ok(rm.phases.length > 0 && rm.totalWeeks > 0);
    assert.equal(rm.phases[0].startWeek, 1);
    for (let i = 1; i < rm.phases.length; i++) assert.equal(rm.phases[i].startWeek, rm.phases[i - 1].endWeek + 1, 'phases follow each other');
    assert.ok(rm.phases.some((p) => p.resources.length && /^https:\/\//.test(p.resources[0].url)), 'resources carry links');
    assert.ok(!rm.phases.some((p) => p.skill === 'JavaScript' && p.fromLevel < 4), 'a skill already at the required level is not on the roadmap');
    const hist = ok(await api('GET', '/student/skill-gap/history', { as: S.s1 }));
    assert.ok(hist.history.length >= 1, 'each gap view records a daily snapshot');
    assert.equal((await api('DELETE', `/student/skills/${added.skill.id}`, { as: S.s2 })).status, 404);
    assert.equal((await api('DELETE', `/student/skills/${added.skill.id}`, { as: S.s1 })).status, 204);
  });

  // ================================================================ resume
  it('resume: auto-filled from verified data; templates; update; ATS; AI assistant; limits', async () => {
    const tpl = ok(await api('GET', '/student/resumes/templates', { as: S.s1 }));
    assert.equal(tpl.templates.length, 5);

    const r = ok(await api('POST', '/student/resumes', { as: S.s1, body: { title: 'Main', templateKey: 'classic' } }), 201);
    S.resumeId = r.resume.id;
    const full = ok(await api('GET', `/student/resumes/${S.resumeId}`, { as: S.s1 }));
    assert.equal(full.data.projects.length, 1, 'verified project is included');
    assert.equal(full.data.certificates.length, 1);
    assert.ok(full.ats.score >= 0 && full.ats.score <= 100);
    assert.ok(Array.isArray(full.ats.breakdown) && full.ats.breakdown.length === 7);
    assert.equal(full.ats.breakdown.reduce((s, b) => s + b.max, 0), 100);

    // an UNVERIFIED project must never appear
    const sneaky = ok(await api('POST', '/student/portfolio', { as: S.s1, body: { type: 'project', title: 'Unverified idea', bullets: ['Did stuff'] } }), 201);
    const again = ok(await api('GET', `/student/resumes/${S.resumeId}`, { as: S.s1 }));
    assert.ok(!again.data.projects.some((p) => p.id === sneaky.item.id));
    await pool.query('DELETE FROM portfolio_items WHERE id = $1', [sneaky.item.id]);

    const before = full.ats.score;
    const upd = ok(await api('PUT', `/student/resumes/${S.resumeId}`, { as: S.s1, body: {
      templateKey: 'modern', sectionOrder: ['summary', 'skills', 'projects', 'education', 'certificates'],
      content: { summary: 'Final-year CSE student building web apps with Node.js and React; shipped a portal used by 2,000 students.', extraSkills: ['Teamwork'], hidden: [] } } }));
    assert.equal(upd.resume.templateKey, 'modern');
    const aft = ok(await api('GET', `/student/resumes/${S.resumeId}/ats`, { as: S.s1 }));
    assert.notEqual(aft.ats.score, undefined);
    assert.ok(aft.ats.score >= 0, `ATS before ${before}, after ${aft.ats.score}`);

    assert.equal(code(await api('PUT', `/student/resumes/${S.resumeId}`, { as: S.s1, body: { sectionOrder: ['summary', 'summary'] } })), 'VALIDATION_ERROR');
    assert.equal(code(await api('PUT', `/student/resumes/${S.resumeId}`, { as: S.s1, body: { content: { bogus: 1 } } })), 'VALIDATION_ERROR');
    assert.equal((await api('GET', `/student/resumes/${S.resumeId}`, { as: S.s2 })).status, 404);

    const ai = ok(await api('POST', `/student/resumes/${S.resumeId}/ai/improve`, { as: S.s1, body: { section: 'bullet', text: 'worked on the website for students' } }));
    assert.ok(Array.isArray(ai.suggestions) && ai.suggestions.length > 0, JSON.stringify(ai));
    assert.ok(ai.issues.length > 0, 'weak bullet is flagged');
    assert.equal(ai.source, 'rules', 'no ANTHROPIC_API_KEY in tests → rule-based fallback');
    assert.equal(code(await api('POST', `/student/resumes/${S.resumeId}/ai/improve`, { as: S.s1, body: { section: 'bullet', text: '' } })), 'VALIDATION_ERROR');

    for (let i = 0; i < 4; i++) ok(await api('POST', '/student/resumes', { as: S.s1, body: { title: `R${i}` } }), 201);
    assert.equal(code(await api('POST', '/student/resumes', { as: S.s1, body: { title: 'one too many' } })), 'RESUME_LIMIT');
    assert.equal((await api('DELETE', `/student/resumes/${S.resumeId}`, { as: S.s1 })).status, 204);
  });

  // ================================================================ dashboard, leaderboard, extras
  it('dashboard aggregates only verified data and awards badges', async () => {
    const d = ok(await api('GET', '/student/dashboard', { as: S.s1 }));
    assert.equal(d.state, 'approved');
    assert.equal(d.attendance.held, 60, 'the pending attendance claim is not counted');
    assert.equal(d.attendance.percentage, 86.67);
    assert.deepEqual(d.attendance.lowSubjects.map((x) => x.code), ['CS102']);
    assert.equal(d.certificates.verified, 1);
    assert.equal(d.portfolio.projects, 1);
    assert.ok(d.placementReadiness >= 0 && d.placementReadiness <= 100, `placement ${d.placementReadiness}`);
    assert.equal(d.rank.of, 3, 'all three approved students are ranked');
    assert.equal(d.rank.rank, 1, 's1 has the strongest verified data');
    assert.ok(d.suggestions.length <= 3);
    assert.equal(d.skillGap.role, 'Web Developer');
    const badges = ok(await api('GET', '/student/badges', { as: S.s1 }));
    assert.ok(badges.badges.some((b) => b.code === 'FIRST_CERT' && b.earned), 'first verified certificate earns a badge');
  });

  it('leaderboard shows names and totals only — never other students\' details', async () => {
    const lb = ok(await api('GET', '/student/leaderboard', { as: S.s1 }));
    assert.equal(lb.classSize, 3);
    assert.equal(lb.board.length, 3);
    const other = lb.board.find((e) => !e.isMe);
    assert.ok(other.name && typeof other.total === 'number');
    assert.deepEqual(Object.keys(other).sort(), ['isMe', 'name', 'rank', 'total'], 'only rank, name and total are shared');
    assert.ok(lb.me.components, 'a student sees their own component breakdown');
    assert.equal(lb.me.rank, lb.board.find((e) => e.isMe).rank);
    assert.ok(lb.board[0].total >= lb.board[1].total, 'sorted best-first');
    assert.equal(JSON.stringify(lb).includes('@test.example'), false, 'no e-mail addresses anywhere in the payload');
  });

  it('goals, study plan, announcements, verification status behave', async () => {
    const g = ok(await api('POST', '/student/goals', { as: S.s1, body: { type: 'cgpa', title: 'Reach 8.5', targetValue: 8.5 } }), 201);
    const goals = ok(await api('GET', '/student/goals', { as: S.s1 })).goals;
    assert.equal(goals[0].type, 'cgpa'); assert.ok(goals[0].currentValue != null, 'cgpa goal tracks the verified metric');
    assert.equal((await api('DELETE', `/student/goals/${g.id}`, { as: S.s2 })).status, 404);
    assert.equal((await api('DELETE', `/student/goals/${g.id}`, { as: S.s1 })).status, 204);

    const plan = ok(await api('POST', '/student/study-plan', { as: S.s1, body: { title: 'SQL joins', plannedDate: new Date().toISOString().slice(0, 10), durationMin: 45 } }), 201);
    assert.ok(plan.id);
    assert.equal(ok(await api('GET', '/student/study-plan', { as: S.s1 })).items.length, 1);

    await pool.query(`INSERT INTO announcements (scope, class_id, author_id, title, body) VALUES ('class',$1,$2,'Mid-term','Next week')`, [S.classId, S.in1.user.id]);
    assert.equal(ok(await api('GET', '/student/announcements', { as: S.s1 })).announcements[0].title, 'Mid-term');

    const vs = ok(await api('GET', '/student/verification-status', { as: S.s1 }));
    assert.ok(vs.items.some((i) => i.type === 'attendance' && i.status === 'pending'));
    assert.ok(vs.items.some((i) => i.type === 'certificate' && i.status === 'verified'));
    assert.equal(vs.items.filter((i) => i.id === S.cert.id).length, 1);
    // s2 sees none of s1's items
    const vs2 = ok(await api('GET', '/student/verification-status', { as: S.s2 }));
    assert.ok(!vs2.items.some((i) => i.id === S.cert.id));
  });

  // ================================================================ notifications
  it('notifications: unread count, mark one, mark all; cannot touch another user\'s', async () => {
    const n = ok(await api('GET', '/notifications', { as: S.s2 }));
    assert.ok(n.notifications.length >= 1 && n.unread >= 1);
    const id = n.notifications[0].id;
    assert.equal((await api('POST', `/notifications/${id}/read`, { as: S.s1 })).status, 404);
    ok(await api('POST', `/notifications/${id}/read`, { as: S.s2 }));
    ok(await api('POST', '/notifications/read-all', { as: S.s2 }));
    assert.equal(ok(await api('GET', '/notifications?unread=true', { as: S.s2 })).notifications.length, 0);
  });

  // ================================================================ leaving a class
  it('leaving a class withdraws open requests and returns the student to the join gate', async () => {
    assert.ok((await pool.query(`SELECT 1 FROM verification_requests WHERE student_id=$1 AND status='pending'`, [S.s3.user.id])).rowCount >= 0);
    ok(await api('PATCH', '/student/profile', { as: S.s3, body: { gender: 'male' } }));
    assert.equal((await pool.query(`SELECT 1 FROM verification_requests WHERE student_id=$1 AND status='pending'`, [S.s3.user.id])).rowCount, 1);
    ok(await api('POST', '/student/class/leave', { as: S.s3 }));
    assert.equal((await pool.query(`SELECT 1 FROM verification_requests WHERE student_id=$1 AND status='pending'`, [S.s3.user.id])).rowCount, 0);
    assert.equal(ok(await api('GET', '/student/dashboard', { as: S.s3 })).state, 'no_class');
    assert.equal(code(await api('POST', '/student/class/leave', { as: S.s3 })), 'NOT_IN_CLASS');
    ok(await api('POST', '/join/class', { as: S.s3, body: { classKey: S.classKey } }), 201);        // can join again
  });
});
