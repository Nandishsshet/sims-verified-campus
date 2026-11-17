'use strict';
/**
 * npm run seed:demo
 *
 * Fills an EMPTY database with a believable demo hierarchy so every dashboard has something to show:
 *   Demo University → Demo Institute of Technology → CSE 2023-2027 (semester 3) → 12 students
 *                                                  → ECE 2023-2027 (semester 3) →  8 students (weaker; Phase 5 extras)
 *                    → Lakeside College of Engineering → CSE 2024-2028 (semester 2) → 6 students (Phase 6 extras)
 *                    → Riverside Arts & Science College (registered, left pending for the head to approve)
 * On a database that already has the CSE data, running it again only adds whichever extras are missing.
 * It goes through the real HTTP API for everything that has rules (signup, keys, approvals) and uses
 * SQL only for bulk data that normally arrives from the instructor (verified marks / attendance).
 * Needs: the database running (`npm run dev:db`) and DATABASE_URL / JWT_ACCESS_SECRET in .env.
 *
 * All demo accounts share the password below. NEVER run this against a real deployment.
 */
// The demo accounts share a published password. Never create them on a production database by accident.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'yes') {
  console.error('Refusing to seed demo data with NODE_ENV=production (the demo accounts use a public password).\nIf this really is a throw-away demo deployment, run again with ALLOW_DEMO_SEED=yes.');
  process.exit(1);
}
process.env.TRUST_PROXY = '1';                       // so each seeded request can carry its own X-Forwarded-For
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '8';
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { deriveMark } = require('../src/services/academics');
const { generateVerificationCode } = require('../src/utils/keygen');
const upload = require('../src/utils/upload');

const PASSWORD = 'Demo@12345';
const DOMAIN = 'demo.sims.test';

// small deterministic PRNG so the demo looks the same every time
let seed = 20260;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let ipN = 0;
let base;
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': `10.99.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}` };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}
const signup = (kind, fullName, email, extra = {}) => api('POST', `/auth/signup/${kind}`, { body: { fullName, email, password: PASSWORD, ...extra } });

const SUBJECTS = {
  1: [['CS101', 'Programming in C', 4], ['MA101', 'Engineering Mathematics I', 4], ['PH101', 'Engineering Physics', 3], ['EE101', 'Basic Electrical Engineering', 3], ['HS101', 'Communication Skills', 2]],
  2: [['CS201', 'Data Structures', 4], ['MA201', 'Engineering Mathematics II', 4], ['CS202', 'Digital Logic Design', 3], ['CS203', 'Object-Oriented Programming', 4], ['CH201', 'Environmental Studies', 2]],
  3: [['CS301', 'Design & Analysis of Algorithms', 4], ['CS302', 'Database Management Systems', 4], ['CS303', 'Operating Systems', 4], ['CS304', 'Web Technologies', 3], ['MA301', 'Discrete Mathematics', 3]],
};

const STUDENTS = [  // [name, strength 0..1, certificates, projects]
  ['Aarav Sharma', 0.84, 3, 2], ['Diya Patel', 0.93, 4, 3], ['Rohan Mehta', 0.72, 2, 1], ['Ananya Iyer', 0.88, 3, 2],
  ['Kabir Singh', 0.55, 1, 0], ['Meera Nair', 0.79, 2, 2], ['Vihaan Gupta', 0.64, 1, 1], ['Ishita Rao', 0.91, 5, 3],
  ['Arjun Reddy', 0.48, 0, 0], ['Saanvi Joshi', 0.76, 2, 1], ['Aditya Verma', 0.68, 1, 1], ['Priya Menon', 0.82, 3, 2],
];
const CERTS = [
  ['Python for Everybody', 'course', 'Coursera', ['Python']], ['SQL for Data Science', 'course', 'Coursera', ['SQL']],
  ['Responsive Web Design', 'course', 'freeCodeCamp', ['HTML', 'CSS']], ['JavaScript Algorithms & Data Structures', 'course', 'freeCodeCamp', ['JavaScript']],
  ['Smart India Hackathon — Finalist', 'hackathon', 'Govt. of India', ['Problem Solving']], ['Docker Essentials', 'workshop', 'IBM Skills', ['Docker']],
  ['Git & GitHub Bootcamp', 'workshop', 'Udemy', ['Git']], ['Machine Learning Foundations', 'course', 'Kaggle', ['Machine Learning', 'Python']],
  ['React — The Complete Guide', 'course', 'Udemy', ['React']], ['Inter-college Football — Winners', 'sports', 'State University', []],
];
const PROJECTS = [
  ['Campus Connect', 'Student portal with notices, timetable and e-library.', ['Built a REST API serving 1,800+ students with sub-200 ms median latency', 'Designed a role-based access model reducing admin tickets by 35%'], ['Node.js', 'React', 'PostgreSQL'], ['Node.js', 'React', 'PostgreSQL']],
  ['Expense Tracker', 'Personal finance app with budgets and charts.', ['Implemented budget alerts used by 120 beta testers', 'Visualised spending trends with interactive charts'], ['JavaScript', 'HTML', 'CSS'], ['JavaScript', 'HTML', 'CSS']],
  ['Sentiment Analyzer', 'Classifies product reviews as positive / negative.', ['Trained a classifier reaching 89% accuracy on 20,000 reviews', 'Deployed the model behind a Flask API'], ['Python', 'Scikit-learn', 'Pandas'], ['Python', 'Machine Learning', 'Pandas']],
  ['Smart Attendance QR', 'QR based attendance for labs.', ['Reduced roll-call time from 10 minutes to under 1 minute', 'Built a Kotlin Android client and Express backend'], ['Kotlin', 'Express'], ['Kotlin', 'Android']],
];

// ECE: a second department with a weaker class, so the college dashboard has something to compare and flag.
const ECE_SUBJECTS = {
  1: [['EC101', 'Basic Electronics', 4], ['EC102', 'Circuit Theory', 4]],
  2: [['EC201', 'Analog Circuits', 4], ['EC202', 'Signals & Systems', 4]],
  3: [['EC301', 'Digital Signal Processing', 4], ['EC302', 'Electromagnetic Theory', 4], ['EC303', 'Microprocessors', 3]],
};
const ECE_STUDENTS = [['Nikhil Bose', 0.62], ['Tanvi Kulkarni', 0.55], ['Harsh Vora', 0.40], ['Neha Pillai', 0.70], ['Karan Malhotra', 0.35], ['Lakshmi Das', 0.58], ['Yash Chopra', 0.45], ['Pooja Hegde', 0.66]];

/**
 * Stage 2 (College dashboard demo data) — safe to run on its own on a database that already has stage 1:
 *   · Electronics & Communication gets an instructor, a class of 8 students with LOW attendance and a few backlogs
 *   · 3 verifications that have been waiting 9 days (→ "stale" alerts)
 *   · a second, still-pending instructor request
 *   · a past tech talk (CSE) and a past contest (ECE) with attendance marked, plus a college-wide announcement
 */
async function collegeExtras() {
  if ((await pool.query('SELECT 1 FROM users WHERE email = $1', [`instructor2@${DOMAIN}`])).rowCount) { console.log('College demo extras already present.'); return; }
  const today = new Date();
  const login = await api('POST', '/auth/login', { body: { email: `college@${DOMAIN}`, password: PASSWORD } });
  const admin = login.accessToken;
  const { college, key } = await api('GET', '/college', { token: admin });
  const depts = (await api('GET', '/college/departments', { token: admin })).departments;
  const ece = depts.find((d) => d.code === 'ECE');
  const cseDept = depts.find((d) => d.code === 'CSE');
  assert.ok(ece && cseDept && key, 'stage 1 must have created the departments and the College Key');

  // instructor #2 (approved) and instructor #3 (left pending on purpose)
  const inst = await signup('instructor', 'Mr. Rajesh Iyer', `instructor2@${DOMAIN}`, { collegeKey: key.keyValue });
  const pending = (await api('GET', '/college/instructors?status=pending', { token: admin })).instructors.find((i) => i.email === `instructor2@${DOMAIN}`);
  await api('POST', `/college/instructors/${pending.id}/approve`, { token: admin });
  await api('PATCH', `/college/instructors/${pending.id}`, { token: admin, body: { departmentId: ece.id } });
  await signup('instructor', 'Dr. Priya Nambiar', `priya.nambiar@${DOMAIN}`, { collegeKey: key.keyValue });

  const cls = await api('POST', '/classes', { token: inst.accessToken, body: { departmentId: ece.id, branch: 'ECE', admissionYear: 2023, passoutYear: 2027, name: 'ECE 2023-2027', hodName: 'Dr. Ramesh Babu' } });
  const classId = cls.class.id;
  await pool.query('UPDATE classes SET current_semester = 3 WHERE id = $1', [classId]);

  const subj = {};
  for (const [sem, list] of Object.entries(ECE_SUBJECTS)) {
    for (const [code, name, credits] of list) {
      subj[code] = { id: (await pool.query('INSERT INTO subjects (class_id, semester, code, name, credits) VALUES ($1,$2,$3,$4,$5) RETURNING id', [classId, Number(sem), code, name, credits])).rows[0].id, sem: Number(sem) };
    }
  }

  const students = [];
  for (let i = 0; i < ECE_STUDENTS.length; i++) {
    const [name, strength] = ECE_STUDENTS[i];
    const s = await signup('student', name, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN}`);
    const j = await api('POST', '/join/class', { token: s.accessToken, body: { classKey: cls.classKey, rollNumber: `ECE23${String(i + 1).padStart(3, '0')}` } });
    await api('POST', `/classes/${classId}/enrollments/${j.enrollmentId}/approve`, { token: inst.accessToken, body: {} });
    students.push({ id: s.user.id, name, strength });
  }

  for (const s of students) {
    for (const sem of [1, 2]) {
      for (const [code] of ECE_SUBJECTS[sem]) {
        const q = clamp(s.strength + (rnd() - 0.5) * 0.25, 0.25, 1);
        const io = Math.round(40 * clamp(q + 0.05, 0, 1)); const eo = Math.round(60 * q);
        const d = deriveMark({ internalObtained: io, externalObtained: eo });
        await pool.query(
          `INSERT INTO marks (student_id, subject_id, semester, attempt, internal_obtained, internal_max, external_obtained, external_max,
                              grade, grade_points, is_pass, source, verification_status, verified_by, verified_at)
           VALUES ($1,$2,$3,1,$4,40,$5,60,$6,$7,$8,'instructor','verified',$9,now())`,
          [s.id, subj[code].id, sem, io, eo, d.grade, d.gradePoints, d.pass, inst.user.id]);
      }
    }
    for (const [code] of ECE_SUBJECTS[3]) {                         // attendance well below the 75 % threshold
      const p = clamp(0.38 + s.strength * 0.42 + (rnd() - 0.5) * 0.1, 0.3, 0.9);
      const dates = []; const status = [];
      for (let k = 0; k < 30; k++) { dates.push(new Date(today.getTime() - (k * 2 + 1) * 86400000).toISOString().slice(0, 10)); status.push(k < Math.round(p * 30) ? 'present' : 'absent'); }
      await pool.query(
        `INSERT INTO attendance_records (class_id, student_id, subject_id, attendance_date, period, status, source, verification_status, verified_by, verified_at)
         SELECT $1, $2, $3, d::date, 1, st::attendance_status, 'instructor', 'verified', $6, now() FROM unnest($4::text[], $5::text[]) AS t(d, st)`,
        [classId, s.id, subj[code].id, dates, status, inst.user.id]);
    }
  }
  // one verified certificate each for the first four
  for (const [i, s] of students.slice(0, 4).entries()) {
    const buf = Buffer.from(`%PDF-1.4\n% DEMO ECE CERTIFICATE ${i}\n1 0 obj<</Type/Catalog>>endobj\n% ${s.name}\ntrailer<<>>\n%%EOF\n`);
    const rel = await upload.saveFile(s.id, buf, 'pdf');
    await pool.query(
      `INSERT INTO certificates (student_id, title, category, issuer, issue_date, file_path, file_sha256, verification_code, verification_status, verified_by, verified_at)
       VALUES ($1,'Embedded Systems Basics','course','NPTEL',$2,$3,encode(sha256($4::bytea),'hex'),$5,'verified',$6,now())`,
      [s.id, new Date(today.getTime() - 60 * 86400000).toISOString().slice(0, 10), rel, buf, generateVerificationCode(), inst.user.id]);
  }
  // profiles: the last five are verified; the first three stay in the instructor's queue — and have been waiting 9 days
  for (const s of students.slice(3)) {
    await pool.query(`UPDATE student_profiles SET verification_status = 'verified', verified_by = $2, verified_at = now() WHERE user_id = $1`, [s.id, inst.user.id]);
    await pool.query(`DELETE FROM verification_requests WHERE student_id = $1 AND entity_type = 'profile' AND status = 'pending'`, [s.id]);
  }
  await pool.query(`UPDATE verification_requests SET submitted_at = now() - interval '9 days' WHERE class_id = $1 AND status = 'pending'`, [classId]);

  // past events with attendance marked (the future ones from stage 1 have nobody marked yet)
  const cse = (await pool.query(`SELECT id, instructor_id FROM classes WHERE college_id = $1 AND name = 'CSE 2023-2027'`, [college.id])).rows[0];
  const event = async (cId, instructorId, deptId, type, title, venue, daysAgo, rows) => {
    const a = (await pool.query(
      `INSERT INTO activities (class_id, college_id, department_id, type, title, venue, starts_at, is_published, published_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,now(),$8) RETURNING id`, [cId, college.id, deptId, type, title, venue, new Date(today.getTime() - daysAgo * 86400000), instructorId])).rows[0];
    for (const [studentId, status] of rows) await pool.query('INSERT INTO activity_participants (activity_id, student_id, status) VALUES ($1,$2,$3)', [a.id, studentId, status]);
  };
  const cseStudents = (await pool.query(`SELECT student_id FROM class_enrollments WHERE class_id = $1 AND status = 'approved' ORDER BY roll_number LIMIT 7`, [cse.id])).rows;
  await event(cse.id, cse.instructor_id, cseDept.id, 'workshop', 'Tech Talk: Careers in Cloud', 'Seminar Hall', 10, cseStudents.map((r, i) => [r.student_id, i < 5 ? 'attended' : 'absent']));
  await event(classId, inst.user.id, ece.id, 'competition', 'Circuit Design Contest', 'Electronics Lab', 6, students.map((s, i) => [s.id, i === 0 ? 'winner' : i === 3 ? 'attended' : 'registered']));
  await api('POST', '/college/announcements', { token: admin, body: { title: 'Annual Day — 5 December', body: 'Annual Day will be held in the main auditorium. Departments: please nominate performers by the 25th.', pinned: true } });

  console.log('College demo extras created: ECE class (low attendance, stale verifications), a pending instructor, past events, an announcement.');
  console.log(`  Second instructor  instructor2@${DOMAIN}   ·   ECE Class Key ${cls.classKey}`);
}

// Lakeside: a second college under the same university, so the University dashboard has colleges to compare.
const LAKESIDE_SUBJECTS = {
  1: [['LS101', 'Programming Fundamentals', 4], ['LS102', 'Applied Mathematics', 4]],
  2: [['LS201', 'Data Structures', 4], ['LS202', 'Computer Organisation', 4], ['LS203', 'Technical Communication', 2]],
};
const LAKESIDE_STUDENTS = [['Aditi Kulkarni', 0.90], ['Rahul Deshpande', 0.82], ['Sneha Bhatt', 0.78], ['Manav Arora', 0.74], ['Fatima Sheikh', 0.86], ['Omkar Patil', 0.70]];

/**
 * Stage 3 (University dashboard demo data) — safe to run on its own on a database that already has stage 1:
 *   · "Lakeside College of Engineering" (college2@): approved by the head, one CSE class of the 2024 batch,
 *     6 students with high attendance and good marks but few certificates → stronger than Demo Institute on
 *     attendance and SGPA, weaker on certificates / placement
 *   · "Riverside Arts & Science College" (college3@): registered but left PENDING, so the approval queue is not empty
 *   · a university-wide announcement from the head
 */
async function universityExtras() {
  if ((await pool.query('SELECT 1 FROM users WHERE email = $1', [`college2@${DOMAIN}`])).rowCount) { console.log('University demo extras already present.'); return; }
  const today = new Date();
  const head = (await api('POST', '/auth/login', { body: { email: `head@${DOMAIN}`, password: PASSWORD } })).accessToken;
  const { key: uKey } = await api('GET', '/university', { token: head });
  assert.ok(uKey, 'stage 1 must have created the University Key');

  // Lakeside is registered with the University Key, then approved by the head (which issues its College Key)
  const admin = await signup('college-admin', 'Dr. Meenakshi Sundaram', `college2@${DOMAIN}`, { universityKey: uKey.keyValue, college: { name: 'Lakeside College of Engineering', principalName: 'Dr. Meenakshi Sundaram', affiliation: 'Demo University' } });
  const approved = await api('POST', `/university/colleges/${admin.college.id}/approve`, { token: head });
  const dept = (await api('POST', '/college/departments', { token: admin.accessToken, body: { name: 'Computer Science', code: 'CSE', hodName: 'Dr. Vikram Seth' } })).department;
  const inst = await signup('instructor', 'Ms. Lakshmi Narayan', `instructor3@${DOMAIN}`, { collegeKey: approved.collegeKey });
  const pending = (await api('GET', '/college/instructors?status=pending', { token: admin.accessToken })).instructors[0];
  await api('POST', `/college/instructors/${pending.id}/approve`, { token: admin.accessToken });

  const cls = await api('POST', '/classes', { token: inst.accessToken, body: { departmentId: dept.id, branch: 'CSE', admissionYear: 2024, passoutYear: 2028, name: 'CSE 2024-2028', hodName: 'Dr. Vikram Seth' } });
  const classId = cls.class.id;
  await pool.query('UPDATE classes SET current_semester = 2 WHERE id = $1', [classId]);
  const subj = {};
  for (const [sem, list] of Object.entries(LAKESIDE_SUBJECTS)) {
    for (const [code, name, credits] of list) {
      subj[code] = (await pool.query('INSERT INTO subjects (class_id, semester, code, name, credits) VALUES ($1,$2,$3,$4,$5) RETURNING id', [classId, Number(sem), code, name, credits])).rows[0].id;
    }
  }
  const students = [];
  for (const [i, [name, strength]] of LAKESIDE_STUDENTS.entries()) {
    const s = await signup('student', name, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN}`);
    const j = await api('POST', '/join/class', { token: s.accessToken, body: { classKey: cls.classKey, rollNumber: `LCE24${String(i + 1).padStart(3, '0')}` } });
    await api('POST', `/classes/${classId}/enrollments/${j.enrollmentId}/approve`, { token: inst.accessToken, body: {} });
    students.push({ id: s.user.id, name, strength });
  }
  for (const s of students) {
    for (const [code] of LAKESIDE_SUBJECTS[1]) {                    // semester 1 marks
      const q = clamp(s.strength + (rnd() - 0.5) * 0.12, 0.4, 1);
      const io = Math.round(40 * clamp(q + 0.03, 0, 1)); const eo = Math.round(60 * q);
      const d = deriveMark({ internalObtained: io, externalObtained: eo });
      await pool.query(
        `INSERT INTO marks (student_id, subject_id, semester, attempt, internal_obtained, internal_max, external_obtained, external_max,
                            grade, grade_points, is_pass, source, verification_status, verified_by, verified_at)
         VALUES ($1,$2,1,1,$3,40,$4,60,$5,$6,$7,'instructor','verified',$8,now())`,
        [s.id, subj[code], io, eo, d.grade, d.gradePoints, d.pass, inst.user.id]);
    }
    for (const [code] of LAKESIDE_SUBJECTS[2]) {                    // semester 2 attendance: high
      const p = clamp(0.80 + s.strength * 0.15 + (rnd() - 0.5) * 0.06, 0.75, 0.99);
      const dates = []; const status = [];
      for (let k = 0; k < 30; k++) { dates.push(new Date(today.getTime() - (k * 2 + 1) * 86400000).toISOString().slice(0, 10)); status.push(k < Math.round(p * 30) ? 'present' : 'absent'); }
      await pool.query(
        `INSERT INTO attendance_records (class_id, student_id, subject_id, attendance_date, period, status, source, verification_status, verified_by, verified_at)
         SELECT $1, $2, $3, d::date, 1, st::attendance_status, 'instructor', 'verified', $6, now() FROM unnest($4::text[], $5::text[]) AS t(d, st)`,
        [classId, s.id, subj[code], dates, status, inst.user.id]);
    }
    await pool.query(`UPDATE student_profiles SET verification_status = 'verified', verified_by = $2, verified_at = now() WHERE user_id = $1`, [s.id, inst.user.id]);
    await pool.query(`DELETE FROM verification_requests WHERE student_id = $1 AND entity_type = 'profile' AND status = 'pending'`, [s.id]);
  }
  // only the two strongest have a verified certificate → "certificates" is this college's weak spot
  for (const [i, s] of students.filter((x) => x.strength >= 0.86).entries()) {
    const buf = Buffer.from(`%PDF-1.4\n% DEMO LAKESIDE CERTIFICATE ${i}\n1 0 obj<</Type/Catalog>>endobj\n% ${s.name}\ntrailer<<>>\n%%EOF\n`);
    const rel = await upload.saveFile(s.id, buf, 'pdf');
    await pool.query(
      `INSERT INTO certificates (student_id, title, category, issuer, issue_date, file_path, file_sha256, verification_code, verification_status, verified_by, verified_at)
       VALUES ($1,'Introduction to Algorithms','course','NPTEL',$2,$3,encode(sha256($4::bytea),'hex'),$5,'verified',$6,now())`,
      [s.id, new Date(today.getTime() - 45 * 86400000).toISOString().slice(0, 10), rel, buf, generateVerificationCode(), inst.user.id]);
  }

  // a college that registered but has not been approved yet
  await signup('college-admin', 'Dr. Arvind Menon', `college3@${DOMAIN}`, { universityKey: uKey.keyValue, college: { name: 'Riverside Arts & Science College', principalName: 'Dr. Arvind Menon', affiliation: 'Demo University' } });

  await api('POST', '/university/announcements', { token: head, body: { title: 'Semester examinations — schedule published', body: 'The examination timetable for the coming semester is on the university portal. Colleges: please confirm hall-ticket distribution by the end of the month.', pinned: true } });

  console.log('University demo extras created: Lakeside College (approved, 6 students, 2024 batch), Riverside College (pending), a university announcement.');
  console.log(`  Second college admin  college2@${DOMAIN}   ·   third (pending) college3@${DOMAIN}   ·   Lakeside instructor instructor3@${DOMAIN}`);
}

(async () => {
  const server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const exists = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [`head@${DOMAIN}`]);
    if (exists.rowCount) { console.log('Core demo data is already present.'); await collegeExtras(); await universityExtras(); console.log('(Full reset: stop dev:db, delete backend/.pgdata-dev and backend/uploads)'); return; }
    const cat = await pool.query('SELECT count(*)::int AS n FROM skills');
    if (!cat.rows[0].n) throw new Error('Catalogue is empty — run `npm run db:catalog` first');
    const skill = new Map((await pool.query('SELECT id, name FROM skills')).rows.map((r) => [r.name, r.id]));
    const role = new Map((await pool.query('SELECT id, name FROM career_roles')).rows.map((r) => [r.name, r.id]));

    // ---------------------------------------------------------------- hierarchy via the real API
    const head = await signup('university-head', 'Dr. Kavita Rao', `head@${DOMAIN}`, { university: { name: 'Demo University', headTitle: 'Vice-Chancellor' } });
    const admin = await signup('college-admin', 'Prof. Suresh Kumar', `college@${DOMAIN}`, { universityKey: head.universityKey, college: { name: 'Demo Institute of Technology', principalName: 'Prof. Suresh Kumar', affiliation: 'Demo University' } });
    const approved = await api('POST', `/university/colleges/${admin.college.id}/approve`, { token: head.accessToken });
    const dept = (await api('POST', '/college/departments', { token: admin.accessToken, body: { name: 'Computer Science & Engineering', code: 'CSE', hodName: 'Dr. Anita Desai' } })).department;
    await api('POST', '/college/departments', { token: admin.accessToken, body: { name: 'Electronics & Communication', code: 'ECE', hodName: 'Dr. Ramesh Babu' } });

    const inst = await signup('instructor', 'Ms. Neha Kapoor', `instructor@${DOMAIN}`, { collegeKey: approved.collegeKey });
    const m = (await api('GET', '/college/instructors?status=pending', { token: admin.accessToken })).instructors[0].id;
    await api('POST', `/college/instructors/${m}/approve`, { token: admin.accessToken });
    const cls = await api('POST', '/classes', { token: inst.accessToken, body: { departmentId: dept.id, branch: 'CSE', admissionYear: 2023, passoutYear: 2027, name: 'CSE 2023-2027', hodName: 'Dr. Anita Desai' } });
    const classId = cls.class.id;
    await pool.query('UPDATE classes SET current_semester = 3 WHERE id = $1', [classId]);
    const instructorId = inst.user.id;

    // subjects
    const subj = {};   // code → {id, sem}
    for (const [sem, list] of Object.entries(SUBJECTS)) {
      for (const [code, name, credits] of list) {
        const r = await pool.query('INSERT INTO subjects (class_id, semester, code, name, credits) VALUES ($1,$2,$3,$4,$5) RETURNING id', [classId, Number(sem), code, name, credits]);
        subj[code] = { id: r.rows[0].id, sem: Number(sem), name, credits };
      }
    }

    // students: sign up → join with the class key → instructor approves
    const students = [];
    for (let i = 0; i < STUDENTS.length; i++) {
      const [name, strength, nCerts, nProjects] = STUDENTS[i];
      const email = i === 0 ? `student@${DOMAIN}` : `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN}`;
      const s = await signup('student', name, email);
      const j = await api('POST', '/join/class', { token: s.accessToken, body: { classKey: cls.classKey, rollNumber: `CSE23${String(i + 1).padStart(3, '0')}` } });
      await api('POST', `/classes/${classId}/enrollments/${j.enrollmentId}/approve`, { token: inst.accessToken, body: {} });
      students.push({ id: s.user.id, token: s.accessToken, name, email, strength, nCerts, nProjects, demo: i === 0 });
    }

    // ---------------------------------------------------------------- verified marks (semesters 1–2) & attendance (semester 3)
    const today = new Date();
    for (const s of students) {
      for (const sem of [1, 2]) {
        for (const [code] of SUBJECTS[sem]) {
          const q = clamp(s.strength + (rnd() - 0.5) * 0.25, 0.3, 1);
          let io = Math.round(40 * clamp(q + 0.05, 0, 1)); let eo = Math.round(60 * q);
          if (s.demo && code === 'MA201') { io = 12; eo = 14; }                       // the demo student has one backlog
          const d = deriveMark({ internalObtained: io, externalObtained: eo });
          await pool.query(
            `INSERT INTO marks (student_id, subject_id, semester, attempt, internal_obtained, internal_max, external_obtained, external_max,
                                grade, grade_points, is_pass, source, verification_status, verified_by, verified_at)
             VALUES ($1,$2,$3,1,$4,40,$5,60,$6,$7,$8,'instructor','verified',$9,now())`,
            [s.id, subj[code].id, sem, io, eo, d.grade, d.gradePoints, d.pass, instructorId]);
        }
      }
      for (const [code] of SUBJECTS[3]) {
        let p = clamp(0.62 + s.strength * 0.36 + (rnd() - 0.5) * 0.12, 0.45, 0.99);
        if (s.demo) p = code === 'CS302' ? 0.68 : 0.9;                               // demo student: DBMS attendance is low
        const dates = []; const status = [];
        for (let k = 0; k < 40; k++) {
          dates.push(new Date(today.getTime() - (k * 2 + 1) * 86400000).toISOString().slice(0, 10));
          status.push(k < Math.round(p * 40) ? 'present' : 'absent');
        }
        await pool.query(
          `INSERT INTO attendance_records (class_id, student_id, subject_id, attendance_date, period, status, source, verification_status, verified_by, verified_at)
           SELECT $1, $2, $3, d::date, 1, st::attendance_status, 'instructor', 'verified', $6, now() FROM unnest($4::text[], $5::text[]) AS t(d, st)`,
          [classId, s.id, subj[code].id, dates, status, instructorId]);
      }
    }

    // ---------------------------------------------------------------- certificates, projects, skills
    let fileN = 0;
    for (const s of students) {
      for (let i = 0; i < s.nCerts; i++) {
        const [title, category, issuer, skills] = CERTS[(i + students.indexOf(s)) % CERTS.length];
        const buf = Buffer.from(`%PDF-1.4\n% DEMO CERTIFICATE ${++fileN}\n1 0 obj<</Type/Catalog>>endobj\n% ${title} — ${s.name} — ${issuer}\ntrailer<<>>\n%%EOF\n`);
        const rel = await upload.saveFile(s.id, buf, 'pdf');
        const verified = !(s.demo && i === s.nCerts - 1);          // demo student keeps one certificate pending
        const c = (await pool.query(
          `INSERT INTO certificates (student_id, title, category, issuer, issue_date, file_path, file_sha256, verification_code, verification_status, verified_by, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,encode(sha256($7::bytea),'hex'),$8,$9,$10,$11) RETURNING id`,
          [s.id, title, category, issuer, new Date(today.getTime() - (30 + i * 45) * 86400000).toISOString().slice(0, 10), rel, buf,
            verified ? generateVerificationCode() : null, verified ? 'verified' : 'pending', verified ? instructorId : null, verified ? new Date() : null])).rows[0];
        for (const n of skills) if (skill.has(n)) await pool.query(`INSERT INTO student_skills (student_id, skill_id, proficiency, source, certificate_id) VALUES ($1,$2,$3,'certificate',$4) ON CONFLICT DO NOTHING`, [s.id, skill.get(n), 3 + Math.floor(rnd() * 2), c.id]);
        if (!verified) await pool.query(`INSERT INTO verification_requests (class_id, student_id, entity_type, entity_id) VALUES ($1,$2,'certificate',$3)`, [classId, s.id, c.id]);
      }
      for (let i = 0; i < s.nProjects; i++) {
        const [title, description, bullets, tech, skills] = PROJECTS[(i + students.indexOf(s)) % PROJECTS.length];
        const verified = !(s.demo && i === s.nProjects - 1);
        const p = (await pool.query(
          `INSERT INTO portfolio_items (student_id, type, title, role, description, bullets, tech_stack, start_date, end_date, verification_status, verified_by, verified_at)
           VALUES ($1,'project',$2,'Developer',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [s.id, `${title}`, description, bullets, tech, new Date(today.getTime() - 200 * 86400000).toISOString().slice(0, 10), new Date(today.getTime() - 120 * 86400000).toISOString().slice(0, 10),
            verified ? 'verified' : 'pending', verified ? instructorId : null, verified ? new Date() : null])).rows[0];
        for (const n of skills) if (skill.has(n)) await pool.query(`INSERT INTO student_skills (student_id, skill_id, proficiency, source, portfolio_id) VALUES ($1,$2,3,'project',$3) ON CONFLICT DO NOTHING`, [s.id, skill.get(n), p.id]);
        if (!verified) await pool.query(`INSERT INTO verification_requests (class_id, student_id, entity_type, entity_id) VALUES ($1,$2,'project',$3)`, [classId, s.id, p.id]);
      }
      // profile verified by the instructor (the demo student's stays pending)
      await pool.query(
        `UPDATE student_profiles SET date_of_birth = '2005-03-14', gender = $2, summary = $3,
                verification_status = $4, verified_by = $5, verified_at = $6 WHERE user_id = $1`,
        [s.id, pick(['female', 'male']), 'Computer science undergraduate interested in building useful software.', s.demo ? 'pending' : 'verified', s.demo ? null : instructorId, s.demo ? null : new Date()]);
      // approval already queued every student's profile (syncOpenRequests); clear it for those we just verified
      if (!s.demo) await pool.query(`DELETE FROM verification_requests WHERE student_id = $1 AND entity_type = 'profile' AND status = 'pending'`, [s.id]);
    }

    // the demo student's own choices: target role + a few self-declared skills
    const demo = students[0];
    await api('PUT', '/student/target-role', { token: demo.token, body: { roleId: role.get('Web Developer') } });
    for (const [n, lvl] of [['HTML', 4], ['CSS', 3], ['JavaScript', 3], ['Git', 3]]) await api('POST', '/student/skills', { token: demo.token, body: { skillId: skill.get(n), proficiency: lvl } });

    // ---------------------------------------------------------------- class life: timetable, assignments, activities, announcements
    const slots = [['09:00', '10:00'], ['10:00', '11:00'], ['11:15', '12:15'], ['13:15', '14:15'], ['14:15', '15:15']];
    for (let day = 1; day <= 5; day++) {
      for (let k = 0; k < 4; k++) {
        const code = SUBJECTS[3][(day + k) % 5][0];
        await pool.query('INSERT INTO timetable_entries (class_id, subject_id, day_of_week, starts_at, ends_at, room) VALUES ($1,$2,$3,$4,$5,$6)', [classId, subj[code].id, day, slots[k][0], slots[k][1], `Room ${300 + ((day + k) % 5) + 1}`]);
      }
    }
    const day = (n) => new Date(today.getTime() + n * 86400000);
    const assignments = [['DBMS: ER diagram for a library system', 'CS302', 3], ['Algorithms: Dynamic programming problem set', 'CS301', 6], ['Web Tech: Responsive portfolio page', 'CS304', -4]];
    for (const [title, code, due] of assignments) {
      const a = (await pool.query('INSERT INTO assignments (class_id, subject_id, title, description, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [classId, subj[code].id, title, 'Submit before the deadline.', day(due), instructorId])).rows[0];
      if (due < 0) for (const s of students.slice(0, 8)) await pool.query('INSERT INTO assignment_submissions (assignment_id, student_id, submitted_at) VALUES ($1,$2,$3)', [a.id, s.id, day(due - 1)]);
    }
    const acts = [['competition', 'Inter-college Hackathon 2026', 'Auditorium', 9], ['workshop', 'Resume & Interview Skills Workshop', 'Seminar Hall', 5], ['program', 'Placement Aptitude Training — Week 1', 'Room 301', 2]];
    for (const [type, title, venue, inDays] of acts) {
      const a = (await pool.query(
        `INSERT INTO activities (class_id, college_id, department_id, type, title, description, venue, starts_at, is_published, published_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,now(),$9) RETURNING id`, [classId, admin.college.id, dept.id, type, title, 'Open to all students of the class.', venue, day(inDays), instructorId])).rows[0];
      for (const s of students.slice(1, 5)) await pool.query(`INSERT INTO activity_participants (activity_id, student_id) VALUES ($1,$2)`, [a.id, s.id]);
    }
    await pool.query(`INSERT INTO announcements (scope, class_id, title, body, is_pinned, author_id) VALUES ('class',$1,'Mid-semester exams from the 24th','Timetable is on the notice board. Carry your ID card.',true,$2)`, [classId, instructorId]);
    await pool.query(`INSERT INTO announcements (scope, class_id, title, body, author_id) VALUES ('class',$1,'Lab record submission','Submit lab records to Ms. Kapoor by Friday.',$2)`, [classId, instructorId]);

    // a few notifications so the bell isn't empty
    await pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'verification_verified','Certificate verified','Your certificate was verified by your instructor.','/student/certificates')`, [demo.id]);

    // ---------------------------------------------------------------- stage 2: the college dashboard's demo data
    await collegeExtras();
    // ---------------------------------------------------------------- stage 3: the university dashboard's demo data
    await universityExtras();

    // ---------------------------------------------------------------- sanity check, then print the cheat-sheet
    const n =(await pool.query(`SELECT (SELECT count(*) FROM marks)::int AS marks, (SELECT count(*) FROM attendance_records)::int AS att, (SELECT count(*) FROM certificates)::int AS certs`)).rows[0];
    assert.ok(n.marks > 100 && n.att > 2000);

    console.log('\nDemo data created.\n');
    console.log(`  University head   head@${DOMAIN}`);
    console.log(`  College admin     college@${DOMAIN}`);
    console.log(`  Instructor        instructor@${DOMAIN}`);
    console.log(`  Student (demo)    student@${DOMAIN}     (other students: <first>.<last>@${DOMAIN})`);
    console.log(`  2nd college admin college2@${DOMAIN}   (3rd, pending approval: college3@${DOMAIN})`);
    console.log(`  Password (all)    ${PASSWORD}`);
    console.log(`\n  Keys: University ${head.universityKey} · College ${approved.collegeKey} · Class ${cls.classKey}`);
    console.log(`  Rows: ${n.marks} marks, ${n.att} attendance records, ${n.certs} certificates\n`);
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
  }
})().catch((e) => { console.error('Seeding failed:', e.message); process.exit(1); });
