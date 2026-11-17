'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { asyncHandler, badRequest } = require('../../utils/errors');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const { approvedStudentOnly, submitForVerification } = require('./student.common');

router.use(...approvedStudentOnly);

const { DEFAULT_THRESHOLD, stats, subjectBreakdown } = require('./attendance.service');

// GET /student/attendance?semester=current|all|3&month=2026-03&threshold=75
router.get('/', validate({ query: z.object({
  semester: z.string().regex(/^(current|all|\d{1,2})$/).default('current'),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  threshold: z.coerce.number().int().min(1).max(99).default(DEFAULT_THRESHOLD),
}) }), asyncHandler(async (req, res) => {
  const { threshold } = req.query;
  const cls = (await pool.query('SELECT current_semester FROM classes WHERE id = $1', [req.scope.classId])).rows[0];
  const sem = req.query.semester === 'all' ? null : req.query.semester === 'current' ? cls.current_semester : Number(req.query.semester);

  const subjects = await subjectBreakdown(req.user.id, req.scope.classId, sem, threshold);
  const attended = subjects.reduce((s, x) => s + x.attended, 0);
  const held = subjects.reduce((s, x) => s + x.held, 0);

  const now = new Date();
  const month = req.query.month || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const cal = await pool.query(
    `SELECT a.attendance_date::text AS date, a.period, a.status, a.verification_status, s.code, s.name
       FROM attendance_records a JOIN subjects s ON s.id = a.subject_id
      WHERE a.student_id = $1 AND to_char(a.attendance_date, 'YYYY-MM') = $2
      ORDER BY a.attendance_date, a.period`, [req.user.id, month]);
  const days = {};
  for (const r of cal.rows) (days[r.date] ||= []).push({ subject: r.name, code: r.code, period: r.period, status: r.status, verified: r.verification_status === 'verified' });
  const pending = (await pool.query(
    `SELECT count(*)::int AS n FROM attendance_records WHERE student_id = $1 AND source = 'student' AND verification_status <> 'verified'`, [req.user.id])).rows[0].n;

  res.json({
    threshold, semester: sem ?? 'all',
    overall: stats(attended, held, threshold),
    subjects,
    calendar: { month, days: Object.entries(days).map(([date, records]) => ({ date, records })) },
    pendingClaims: pending,
  });
}));

// GET /student/attendance/can-miss?attended=&held=&remaining=&threshold=
// Calculator. With no numbers it uses the student's verified overall attendance (current semester).
router.get('/can-miss', validate({ query: z.object({
  attended: z.coerce.number().int().min(0).optional(),
  held: z.coerce.number().int().min(0).optional(),
  remaining: z.coerce.number().int().min(0).max(1000).optional(),
  threshold: z.coerce.number().int().min(1).max(99).default(DEFAULT_THRESHOLD),
}).refine((q) => q.attended == null || q.held == null || q.attended <= q.held, { message: 'attended cannot exceed held' }) }),
asyncHandler(async (req, res) => {
  const { threshold, remaining } = req.query;
  let { attended, held } = req.query;
  if (attended == null || held == null) {
    const cls = (await pool.query('SELECT current_semester FROM classes WHERE id = $1', [req.scope.classId])).rows[0];
    const subjects = await subjectBreakdown(req.user.id, req.scope.classId, cls.current_semester, threshold);
    attended = subjects.reduce((s, x) => s + x.attended, 0);
    held = subjects.reduce((s, x) => s + x.held, 0);
  }
  res.json({
    threshold, ...stats(attended, held, threshold),
    ...(remaining != null ? { remaining, missableOfRemaining: scoring.missableInRemaining(attended, held, remaining, threshold) } : {}),
  });
}));

// POST /student/attendance/claims — report a class that was never recorded; goes to the instructor
router.post('/claims', validate({ body: z.object({
  subjectId: z.string().uuid(),
  date: z.coerce.date(),
  period: z.number().int().min(1).max(12).default(1),
  note: z.string().trim().min(3).max(300),
}) }), asyncHandler(async (req, res) => {
  const { subjectId, date, period, note } = req.body;
  const day = date.toISOString().slice(0, 10);
  if (date > new Date()) throw badRequest('FUTURE_DATE', 'You cannot claim attendance for a future date');
  if (Date.now() - date.getTime() > 90 * 86400000) throw badRequest('TOO_OLD', 'Claims older than 90 days must go through your instructor');
  const claim = await tx(async (c) => {
    const subj = (await c.query('SELECT id FROM subjects WHERE id = $1 AND class_id = $2', [subjectId, req.scope.classId])).rows[0];
    if (!subj) throw badRequest('INVALID_SUBJECT', 'That subject is not part of your class');
    const row = (await c.query(
      `INSERT INTO attendance_records (class_id, student_id, subject_id, attendance_date, period, status, source, claim_note, verification_status)
       VALUES ($1,$2,$3,$4,$5,'present','student',$6,'pending') RETURNING id, attendance_date::text AS date, period, status, verification_status`,
      [req.scope.classId, req.user.id, subjectId, day, period, note])).rows[0];   // unique clash → 409 RECORD_EXISTS
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'attendance', entityId: row.id, note });
    return row;
  });
  res.status(201).json({ claim });
}));

module.exports = router;
