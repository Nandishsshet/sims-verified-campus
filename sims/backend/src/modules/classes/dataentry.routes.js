'use strict';
/**
 * Instructor data entry — /classes/:classId/{attendance,marks,imports}
 *
 * Instructor and CSV entries are trusted: they are stored already `verified` (the instructor IS the
 * verifier), and they overwrite — and close the open verification request of — any student claim for
 * the same slot. All writes for one request happen in ONE transaction, with audit rows.
 *
 * CSV imports are validated row by row. Valid rows are applied, invalid rows come back in
 * `errorReport` ([{row, field, message}], row = line number in the file) so the file can be fixed
 * and re-uploaded; `?dryRun=1` validates without writing.
 */
const { z } = require('zod');
const router = require('express').Router({ mergeParams: true });
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { validate } = require('../../middleware/validate');
const upload = require('../../utils/upload');
const csv = require('../../utils/csv');
const { deriveMark } = require('../../services/academics');

const MAX_CSV_BYTES = 1024 * 1024;
const MAX_CSV_ROWS = 5000;
const STATUSES = ['present', 'absent', 'late', 'excused'];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Not a real date');
const uuid = z.string().uuid();

/** Today (UTC) + 1 day: instructors in UTC+ zones may be a calendar day ahead of the server. */
const latestAllowedDate = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const notFuture = (d) => d <= latestAllowedDate();

// ---------------------------------------------------------------- shared lookups
async function roster(db, classId) {
  const { rows } = await db.query(
    `SELECT e.student_id, u.full_name, e.roll_number FROM class_enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.class_id = $1 AND e.status = 'approved' ORDER BY e.roll_number NULLS LAST, u.full_name`, [classId]);
  return rows;
}
async function subjectOf(db, classId, subjectId) {
  const s = (await db.query('SELECT id, code, name, semester, credits FROM subjects WHERE id = $1 AND class_id = $2', [subjectId, classId])).rows[0];
  if (!s) throw badRequest('INVALID_SUBJECT', 'That subject does not belong to this class');
  return s;
}
/** Every studentId must be an approved member of this class. */
async function assertStudents(db, classId, studentIds) {
  const { rows } = await db.query(`SELECT student_id FROM class_enrollments WHERE class_id = $1 AND status = 'approved' AND student_id = ANY($2::uuid[])`, [classId, studentIds]);
  const ok = new Set(rows.map((r) => r.student_id));
  const bad = studentIds.filter((id) => !ok.has(id));
  if (bad.length) throw badRequest('INVALID_STUDENT', `${bad.length} student(s) are not approved members of this class`);
}

// ---------------------------------------------------------------- writers (shared by manual entry and CSV)
/** rows: [{studentId, subjectId, date, period, status}] — last row for the same slot wins. */
async function writeAttendance(c, { classId, actorId, source }, rows) {
  const slot = new Map(rows.map((r) => [`${r.studentId}|${r.subjectId}|${r.date}|${r.period}`, r]));
  const list = [...slot.values()];
  if (!list.length) return { inserted: 0, updated: 0 };
  const { rows: out } = await c.query(
    `INSERT INTO attendance_records (class_id, student_id, subject_id, attendance_date, period, status, source, verification_status, verified_by, verified_at)
     SELECT $1::uuid, t.s, t.sub, t.d, t.p, t.st::attendance_status, $7::data_source, 'verified', $8::uuid, now()
       FROM unnest($2::uuid[], $3::uuid[], $4::date[], $5::smallint[], $6::text[]) AS t(s, sub, d, p, st)
     ON CONFLICT ON CONSTRAINT uq_attendance_slot DO UPDATE
        SET status = EXCLUDED.status, source = EXCLUDED.source, verification_status = 'verified',
            verified_by = EXCLUDED.verified_by, verified_at = now(), verifier_remarks = NULL
     RETURNING id, (xmax = 0) AS inserted`,
    [classId, list.map((r) => r.studentId), list.map((r) => r.subjectId), list.map((r) => r.date), list.map((r) => r.period), list.map((r) => r.status), source, actorId]);
  await c.query(
    `UPDATE verification_requests SET status = 'verified', reviewer_id = $2, reviewed_at = now(), reviewer_remarks = 'Recorded by the instructor'
      WHERE entity_type = 'attendance' AND entity_id = ANY($1::uuid[]) AND status = 'pending'`, [out.map((r) => r.id), actorId]);
  return { inserted: out.filter((r) => r.inserted).length, updated: out.filter((r) => !r.inserted).length };
}

/** rows: [{studentId, subjectId, semester, attempt, internalObtained, internalMax, externalObtained, externalMax}] */
async function writeMarks(c, { actorId, source }, rows) {
  const slot = new Map(rows.map((r) => [`${r.studentId}|${r.subjectId}|${r.attempt}`, r]));
  const list = [...slot.values()].map((r) => ({ ...r, d: deriveMark(r) }));
  if (!list.length) return { inserted: 0, updated: 0 };
  const col = (fn) => list.map(fn);
  const { rows: out } = await c.query(
    `INSERT INTO marks (student_id, subject_id, semester, attempt, internal_obtained, internal_max, external_obtained, external_max,
                        grade, grade_points, is_pass, source, verification_status, verified_by, verified_at)
     SELECT t.s, t.sub, t.sem, t.att, t.io, t.im, t.eo, t.em, t.g, t.gp, t.pass, $12::data_source, 'verified', $13::uuid, now()
       FROM unnest($1::uuid[], $2::uuid[], $3::smallint[], $4::smallint[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[],
                   $9::text[], $10::numeric[], $11::boolean[]) AS t(s, sub, sem, att, io, im, eo, em, g, gp, pass)
     ON CONFLICT (student_id, subject_id, attempt) DO UPDATE
        SET internal_obtained = EXCLUDED.internal_obtained, internal_max = EXCLUDED.internal_max,
            external_obtained = EXCLUDED.external_obtained, external_max = EXCLUDED.external_max,
            grade = EXCLUDED.grade, grade_points = EXCLUDED.grade_points, is_pass = EXCLUDED.is_pass,
            source = EXCLUDED.source, verification_status = 'verified', verified_by = EXCLUDED.verified_by,
            verified_at = now(), verifier_remarks = NULL, updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [col((r) => r.studentId), col((r) => r.subjectId), col((r) => r.semester), col((r) => r.attempt),
      col((r) => r.internalObtained), col((r) => r.internalMax), col((r) => r.externalObtained), col((r) => r.externalMax),
      col((r) => r.d.grade), col((r) => r.d.gradePoints), col((r) => r.d.pass), source, actorId]);
  await c.query(
    `UPDATE verification_requests SET status = 'verified', reviewer_id = $2, reviewed_at = now(), reviewer_remarks = 'Recorded by the instructor'
      WHERE entity_type = 'marks' AND entity_id = ANY($1::uuid[]) AND status = 'pending'`, [out.map((r) => r.id), actorId]);
  return { inserted: out.filter((r) => r.inserted).length, updated: out.filter((r) => !r.inserted).length };
}

// ================================================================ ATTENDANCE — manual
const attendanceBody = z.object({
  subjectId: uuid,
  date: isoDate.refine(notFuture, 'Attendance cannot be recorded for a future date'),
  period: z.number().int().min(1).max(12).default(1),
  entries: z.array(z.object({ studentId: uuid, status: z.enum(STATUSES) })).min(1).max(500),
});

// GET /classes/:classId/attendance/sheet?subjectId&date&period — roster pre-filled with what is already recorded
router.get('/attendance/sheet', validate({ query: z.object({ subjectId: uuid, date: isoDate, period: z.coerce.number().int().min(1).max(12).default(1) }) }), asyncHandler(async (req, res) => {
  const { classId } = req.params; const q = req.query;
  const subject = await subjectOf(pool, classId, q.subjectId);
  const existing = (await pool.query(
    `SELECT student_id, status, source, verification_status FROM attendance_records WHERE class_id = $1 AND subject_id = $2 AND attendance_date = $3 AND period = $4`,
    [classId, q.subjectId, q.date, q.period])).rows;
  const by = new Map(existing.map((r) => [r.student_id, r]));
  res.json({
    subject, date: q.date, period: q.period,
    students: (await roster(pool, classId)).map((s) => {
      const e = by.get(s.student_id);
      return { studentId: s.student_id, name: s.full_name, rollNumber: s.roll_number, status: e?.status ?? null, source: e?.source ?? null, verified: e ? e.verification_status === 'verified' : null };
    }),
  });
}));

// POST /classes/:classId/attendance — one subject, one date, one period, many students (re-posting corrects it)
router.post('/attendance', validate({ body: attendanceBody }), asyncHandler(async (req, res) => {
  const { classId } = req.params; const b = req.body;
  const out = await tx(async (c) => {
    await subjectOf(c, classId, b.subjectId);
    await assertStudents(c, classId, b.entries.map((e) => e.studentId));
    const r = await writeAttendance(c, { classId, actorId: req.user.id, source: 'instructor' },
      b.entries.map((e) => ({ studentId: e.studentId, subjectId: b.subjectId, date: b.date, period: b.period, status: e.status })));
    await audit(c, { ...ctxOf(req), action: 'attendance.record', entityType: 'subjects', entityId: b.subjectId, classId, metadata: { date: b.date, period: b.period, ...r } });
    return r;
  });
  res.status(201).json(out);
}));

// ================================================================ MARKS — manual
const marksBody = z.object({
  subjectId: uuid,
  attempt: z.number().int().min(1).max(10).default(1),
  internalMax: z.number().min(0).max(1000).default(40),
  externalMax: z.number().min(0).max(1000).default(60),
  entries: z.array(z.object({ studentId: uuid, internalObtained: z.number().min(0), externalObtained: z.number().min(0) })).min(1).max(500),
}).superRefine((b, ctx) => b.entries.forEach((e, i) => {
  if (e.internalObtained > b.internalMax) ctx.addIssue({ code: 'custom', path: ['entries', i, 'internalObtained'], message: `Internal marks cannot exceed ${b.internalMax}` });
  if (e.externalObtained > b.externalMax) ctx.addIssue({ code: 'custom', path: ['entries', i, 'externalObtained'], message: `External marks cannot exceed ${b.externalMax}` });
}));

// GET /classes/:classId/marks/sheet?subjectId&attempt
router.get('/marks/sheet', validate({ query: z.object({ subjectId: uuid, attempt: z.coerce.number().int().min(1).max(10).default(1) }) }), asyncHandler(async (req, res) => {
  const { classId } = req.params; const q = req.query;
  const subject = await subjectOf(pool, classId, q.subjectId);
  const existing = (await pool.query(
    `SELECT student_id, internal_obtained, internal_max, external_obtained, external_max, verification_status, source FROM marks WHERE subject_id = $1 AND attempt = $2`,
    [q.subjectId, q.attempt])).rows;
  const by = new Map(existing.map((r) => [r.student_id, r]));
  const sample = existing[0];
  res.json({
    subject, attempt: q.attempt,
    internalMax: sample ? Number(sample.internal_max) : 40, externalMax: sample ? Number(sample.external_max) : 60,
    students: (await roster(pool, classId)).map((s) => {
      const m = by.get(s.student_id);
      return { studentId: s.student_id, name: s.full_name, rollNumber: s.roll_number,
        internalObtained: m ? Number(m.internal_obtained) : null, externalObtained: m ? Number(m.external_obtained) : null,
        source: m?.source ?? null, verified: m ? m.verification_status === 'verified' : null };
    }),
  });
}));

// POST /classes/:classId/marks
router.post('/marks', validate({ body: marksBody }), asyncHandler(async (req, res) => {
  const { classId } = req.params; const b = req.body;
  const out = await tx(async (c) => {
    const subject = await subjectOf(c, classId, b.subjectId);
    await assertStudents(c, classId, b.entries.map((e) => e.studentId));
    const r = await writeMarks(c, { actorId: req.user.id, source: 'instructor' },
      b.entries.map((e) => ({ studentId: e.studentId, subjectId: b.subjectId, semester: subject.semester, attempt: b.attempt,
        internalObtained: e.internalObtained, internalMax: b.internalMax, externalObtained: e.externalObtained, externalMax: b.externalMax })));
    await audit(c, { ...ctxOf(req), action: 'marks.record', entityType: 'subjects', entityId: b.subjectId, classId, metadata: { attempt: b.attempt, ...r } });
    return r;
  });
  res.status(201).json(out);
}));

// ================================================================ CSV import
const ok = (v) => v !== undefined && v !== null && v !== '';

/** Read the uploaded CSV into records, enforcing size / type / row limits. */
function readCsv(req, required) {
  if (!req.file) throw badRequest('NO_FILE', 'Attach a CSV file in the "file" field');
  const buf = req.file.buffer;
  if (buf.includes(0)) throw badRequest('INVALID_FILE_TYPE', 'That does not look like a CSV text file');
  let parsed;
  try { parsed = csv.parse(buf.toString('utf8')); } catch (e) { throw badRequest('INVALID_CSV', e.message); }
  const missing = required.filter((h) => !parsed.headers.includes(h));
  if (missing.length) throw badRequest('MISSING_COLUMNS', `Missing column(s): ${missing.join(', ')}. Download the template for the exact format.`);
  if (parsed.records.length > MAX_CSV_ROWS) throw badRequest('TOO_MANY_ROWS', `At most ${MAX_CSV_ROWS} rows per import`);
  if (!parsed.records.length) throw badRequest('EMPTY_FILE', 'The file has a header but no data rows');
  return parsed.records;
}

/** Roll-number and subject-code lookups for one class. */
async function lookups(db, classId) {
  const [students, subjects, cls] = await Promise.all([
    roster(db, classId),
    db.query('SELECT id, code, name, semester FROM subjects WHERE class_id = $1', [classId]),
    db.query('SELECT current_semester FROM classes WHERE id = $1', [classId]),
  ]);
  const byRoll = new Map();
  for (const s of students) if (s.roll_number) byRoll.set(s.roll_number.toLowerCase(), s);
  const byCode = new Map();
  for (const s of subjects.rows) { const k = s.code.toLowerCase(); if (!byCode.has(k)) byCode.set(k, []); byCode.get(k).push(s); }
  return { byRoll, byCode, currentSemester: cls.rows[0].current_semester };
}

/** Resolve "subject_code" (+ optional "semester" column). Defaults to the class's current semester. */
function findSubject(lk, v, errors, line) {
  const list = lk.byCode.get((v.subject_code || '').toLowerCase());
  if (!list) { errors.push({ row: line, field: 'subject_code', message: `Unknown subject code "${v.subject_code}"` }); return null; }
  if (ok(v.semester)) {
    const sem = Number(v.semester);
    const hit = list.find((s) => s.semester === sem);
    if (!hit) errors.push({ row: line, field: 'semester', message: `${v.subject_code} is not taught in semester ${v.semester}` });
    return hit || null;
  }
  if (list.length === 1) return list[0];
  return list.find((s) => s.semester === lk.currentSemester)
    ?? (errors.push({ row: line, field: 'semester', message: `${v.subject_code} exists in several semesters — add a "semester" column` }), null);
}

function findStudent(lk, v, errors, line) {
  const s = lk.byRoll.get((v.roll_number || '').toLowerCase());
  if (!s) errors.push({ row: line, field: 'roll_number', message: `No approved student with roll number "${v.roll_number}"` });
  return s || null;
}

const importers = {
  attendance: {
    columns: ['roll_number', 'subject_code', 'date', 'status'],
    validate(records, lk) {
      const errors = []; const rows = [];
      for (const { line, values: v } of records) {
        const n = errors.length;
        const student = findStudent(lk, v, errors, line);
        const subject = findSubject(lk, v, errors, line);
        const d = isoDate.safeParse(v.date);
        if (!d.success) errors.push({ row: line, field: 'date', message: d.error.issues[0].message });
        else if (!notFuture(v.date)) errors.push({ row: line, field: 'date', message: 'Date is in the future' });
        const status = (v.status || '').toLowerCase();
        if (!STATUSES.includes(status)) errors.push({ row: line, field: 'status', message: `Status must be one of ${STATUSES.join(', ')}` });
        const period = ok(v.period) ? Number(v.period) : 1;
        if (!Number.isInteger(period) || period < 1 || period > 12) errors.push({ row: line, field: 'period', message: 'Period must be 1–12' });
        if (errors.length === n) rows.push({ studentId: student.student_id, subjectId: subject.id, date: v.date, period, status });
      }
      return { errors, rows };
    },
    write: (c, ctx, rows) => writeAttendance(c, { ...ctx, source: 'csv_import' }, rows),
  },
  marks: {
    columns: ['roll_number', 'subject_code', 'internal', 'external'],
    validate(records, lk) {
      const errors = []; const rows = [];
      for (const { line, values: v } of records) {
        const n = errors.length;
        const student = findStudent(lk, v, errors, line);
        const subject = findSubject(lk, v, errors, line);
        const num = (field, fallback) => {
          if (!ok(v[field])) { if (fallback === undefined) errors.push({ row: line, field, message: 'Required' }); return fallback; }
          const x = Number(v[field]);
          if (!Number.isFinite(x) || x < 0) { errors.push({ row: line, field, message: 'Must be a number ≥ 0' }); return undefined; }
          return x;
        };
        const internalMax = num('internal_max', 40); const externalMax = num('external_max', 60);
        const internalObtained = num('internal'); const externalObtained = num('external');
        const attempt = ok(v.attempt) ? Number(v.attempt) : 1;
        if (!Number.isInteger(attempt) || attempt < 1 || attempt > 10) errors.push({ row: line, field: 'attempt', message: 'Attempt must be 1–10' });
        if (internalObtained > internalMax) errors.push({ row: line, field: 'internal', message: `Cannot exceed internal_max (${internalMax})` });
        if (externalObtained > externalMax) errors.push({ row: line, field: 'external', message: `Cannot exceed external_max (${externalMax})` });
        if (errors.length === n) rows.push({ studentId: student.student_id, subjectId: subject.id, semester: subject.semester, attempt, internalObtained, internalMax, externalObtained, externalMax });
      }
      return { errors, rows };
    },
    write: (c, ctx, rows) => writeMarks(c, { ...ctx, source: 'csv_import' }, rows),
  },
};

// POST /classes/:classId/attendance/import  and  /marks/import   (multipart: file=CSV ≤ 1 MB, ?dryRun=1)
for (const kind of Object.keys(importers)) {
  router.post(`/${kind}/import`, upload.singleFile(MAX_CSV_BYTES), validate({ query: z.object({ dryRun: z.enum(['1', 'true', '0', 'false']).optional() }) }), asyncHandler(async (req, res) => {
    const { classId } = req.params;
    const imp = importers[kind];
    const dryRun = ['1', 'true'].includes(req.query.dryRun);
    const records = readCsv(req, imp.columns);
    const lk = await lookups(pool, classId);
    const { errors, rows } = imp.validate(records, lk);
    const summary = { totalRows: records.length, okRows: new Set(records.map((r) => r.line)).size - new Set(errors.map((e) => e.row)).size, errorRows: new Set(errors.map((e) => e.row)).size };

    if (dryRun) return res.json({ dryRun: true, ...summary, errorReport: errors.slice(0, 200), moreErrors: Math.max(0, errors.length - 200) });

    const job = await tx(async (c) => {
      const written = rows.length ? await imp.write(c, { classId, actorId: req.user.id }, rows) : { inserted: 0, updated: 0 };
      const j = (await c.query(
        `INSERT INTO import_jobs (class_id, kind, file_name, status, total_rows, ok_rows, error_report, created_by, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING id, kind, file_name, status, total_rows, ok_rows, created_at`,
        [classId, kind, String(req.file.originalname || 'upload.csv').slice(0, 200), summary.okRows === 0 ? 'failed' : 'done', summary.totalRows, summary.okRows,
          JSON.stringify(errors.slice(0, 500)), req.user.id])).rows[0];
      await audit(c, { ...ctxOf(req), action: `${kind}.import`, entityType: 'import_jobs', entityId: j.id, classId, metadata: { ...summary, ...written } });
      return { ...j, ...written };
    });
    res.status(job.status === 'failed' ? 422 : 201).json({ dryRun: false, jobId: job.id, status: job.status, ...summary, inserted: job.inserted, updated: job.updated, errorReport: errors.slice(0, 200), moreErrors: Math.max(0, errors.length - 200) });
  }));
}

// GET /classes/:classId/imports/template/:kind — a ready-to-fill CSV (uses a real roll number / subject when the class has them)
router.get('/imports/template/:kind', validate({ params: z.object({ classId: uuid, kind: z.enum(['attendance', 'marks']) }) }), asyncHandler(async (req, res) => {
  const lk = await lookups(pool, req.params.classId);
  const roll = [...lk.byRoll.values()][0]?.roll_number || 'CSE001';
  const code = [...lk.byCode.values()][0]?.[0]?.code || 'CS101';
  const today = new Date().toISOString().slice(0, 10);
  const body = req.params.kind === 'attendance'
    ? csv.toCsv(['roll_number', 'subject_code', 'date', 'period', 'status'], [[roll, code, today, 1, 'present']])
    : csv.toCsv(['roll_number', 'subject_code', 'semester', 'attempt', 'internal', 'internal_max', 'external', 'external_max'], [[roll, code, lk.currentSemester, 1, 32, 40, 48, 60]]);
  res.type('text/csv').set('Content-Disposition', `attachment; filename="${req.params.kind}-template.csv"`).send(body);
}));

// GET /classes/:classId/imports — recent import jobs
router.get('/imports', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT j.id, j.kind, j.file_name, j.status, j.total_rows, j.ok_rows, j.created_at, u.full_name AS by
       FROM import_jobs j JOIN users u ON u.id = j.created_by WHERE j.class_id = $1 ORDER BY j.created_at DESC LIMIT 20`, [req.params.classId]);
  res.json({ imports: rows.map((r) => ({ id: r.id, kind: r.kind, fileName: r.file_name, status: r.status, totalRows: r.total_rows, okRows: r.ok_rows, createdAt: r.created_at, by: r.by })) });
}));

// GET /classes/:classId/imports/:jobId — status + row-level error report
router.get('/imports/:jobId', validate({ params: z.object({ classId: uuid, jobId: uuid }) }), asyncHandler(async (req, res) => {
  const j = (await pool.query('SELECT * FROM import_jobs WHERE id = $1 AND class_id = $2', [req.params.jobId, req.params.classId])).rows[0];
  if (!j) throw notFound('Import');
  res.json({ id: j.id, kind: j.kind, fileName: j.file_name, status: j.status, totalRows: j.total_rows, okRows: j.ok_rows, errorReport: j.error_report, createdAt: j.created_at, finishedAt: j.finished_at });
}));

module.exports = router;
