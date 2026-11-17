'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const { deriveMark } = require('../../services/academics');
const { approvedStudentOnly, submitForVerification, idParam } = require('./student.common');
const { loadMetrics } = require('./metrics.service');

router.use(...approvedStudentOnly);

const markRow = (r) => {
  const d = deriveMark({ internalObtained: Number(r.internal_obtained), internalMax: Number(r.internal_max), externalObtained: Number(r.external_obtained), externalMax: Number(r.external_max) });
  return {
    subjectId: r.subject_id, code: r.code, name: r.name, credits: Number(r.credits), attempt: r.attempt,
    internal: { obtained: Number(r.internal_obtained), max: Number(r.internal_max) },
    external: { obtained: Number(r.external_obtained), max: Number(r.external_max) },
    total: d.total, percentage: d.percentage, grade: d.grade, gradePoints: d.gradePoints, pass: d.pass,
  };
};

// GET /student/academics — semester marks (verified only), SGPA/CGPA, backlogs, trend + my own pending claims
router.get('/', asyncHandler(async (req, res) => {
  const m = (await loadMetrics(pool, [req.user.id])).get(req.user.id);
  const ids = m.academics.semesters.flatMap((s) => s.subjects.map((x) => x.subject_id));

  // Full mark rows (internal/external split) for the verified, latest attempts
  const detail = ids.length ? (await pool.query(
    `SELECT DISTINCT ON (m.subject_id) m.*, s.code, s.name, s.credits
       FROM marks m JOIN subjects s ON s.id = m.subject_id
      WHERE m.student_id = $1 AND m.verification_status = 'verified' AND m.subject_id = ANY($2::uuid[])
      ORDER BY m.subject_id, m.attempt DESC`, [req.user.id, ids])).rows : [];
  const byId = new Map(detail.map((r) => [r.subject_id, markRow(r)]));

  const claims = (await pool.query(
    `SELECT m.id, m.semester, m.attempt, m.internal_obtained, m.internal_max, m.external_obtained, m.external_max,
            m.subject_id, s.code, s.name, s.credits, m.verification_status, m.verifier_remarks
       FROM marks m JOIN subjects s ON s.id = m.subject_id
      WHERE m.student_id = $1 AND m.verification_status <> 'verified' ORDER BY m.created_at DESC`, [req.user.id])).rows
    .map((r) => ({ id: r.id, semester: r.semester, status: r.verification_status, remarks: r.verifier_remarks, ...markRow(r) }));

  res.json({
    cgpa: m.cgpa, creditsDone: m.creditsDone, trend: m.academics.trend,
    semesters: m.academics.semesters.map((s) => ({
      semester: s.semester, sgpa: s.sgpa, credits: s.credits, creditsEarned: s.creditsEarned, backlogCount: s.backlogCount,
      subjects: s.subjects.map((x) => byId.get(x.subject_id)).filter(Boolean),
    })),
    activeBacklogs: m.academics.activeBacklogs.map((b) => ({ subjectId: b.subject_id, code: b.code, name: b.name, semester: b.semester })),
    claims,
  });
}));

// GET /student/academics/subjects — the class's subjects with where each one stands for me (drives the claim form)
router.get('/subjects', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.code, s.name, s.semester, s.credits, m.attempt, m.is_pass, m.verification_status
       FROM subjects s
       LEFT JOIN LATERAL (SELECT attempt, is_pass, verification_status FROM marks
                           WHERE student_id = $1 AND subject_id = s.id ORDER BY attempt DESC LIMIT 1) m ON true
      WHERE s.class_id = $2 ORDER BY s.semester, s.code`, [req.user.id, req.scope.classId]);
  res.json({ subjects: rows.map((r) => {
    const state = !r.attempt ? 'none' : r.verification_status !== 'verified' ? 'unverified' : r.is_pass ? 'passed' : 'failed';
    return { id: r.id, code: r.code, name: r.name, semester: r.semester, credits: Number(r.credits), state, claimable: state === 'none' || state === 'failed' };
  }) });
}));

// GET /student/academics/predict?targetCgpa=8.5&nextCredits=24 — "what SGPA do I need?"
router.get('/predict', validate({ query: z.object({
  targetCgpa: z.coerce.number().min(0).max(10),
  nextCredits: z.coerce.number().min(1).max(60).default(24),
}) }), asyncHandler(async (req, res) => {
  const m = (await loadMetrics(pool, [req.user.id])).get(req.user.id);
  if (!m.creditsDone) throw badRequest('NO_RESULTS', 'You need at least one verified semester result to predict');
  const { targetCgpa, nextCredits } = req.query;
  const { required, feasible } = scoring.requiredSgpa({ currentCgpa: m.cgpa, creditsDone: m.creditsDone, creditsNext: nextCredits, targetCgpa });
  const highestPossibleCgpa = scoring.cgpa([{ credits: m.creditsDone, sgpa: m.cgpa }, { credits: nextCredits, sgpa: 10 }]);
  res.json({
    currentCgpa: m.cgpa, creditsDone: m.creditsDone, nextCredits, targetCgpa,
    requiredSgpa: Math.max(0, required), feasible, alreadyGuaranteed: required <= 0, highestPossibleCgpa,
  });
}));

// ---- self-reported marks (go to the instructor for verification) -------------------------
// zod 4 cannot .omit() a refined object, so the shared checks are applied to two plain shapes
const markShape = {
  internalObtained: z.number().min(0).max(200),
  externalObtained: z.number().min(0).max(200),
  internalMax: z.number().min(0).max(200).default(40),
  externalMax: z.number().min(0).max(200).default(60),
};
const markChecks = (s) => s
  .refine((v) => v.internalObtained <= v.internalMax && v.externalObtained <= v.externalMax, { message: 'Marks cannot exceed the maximum' })
  .refine((v) => v.internalMax + v.externalMax > 0, { message: 'Maximum marks must be above zero' });
const claimBody = markChecks(z.object({ subjectId: z.string().uuid(), ...markShape }));
const claimPatchBody = markChecks(z.object(markShape));

const mapClaimRow = (r) => ({ id: r.id, subjectId: r.subject_id, attempt: r.attempt, status: r.verification_status });

// POST /student/academics/claims
router.post('/claims', validate({ body: claimBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    const subj = (await c.query('SELECT id, semester FROM subjects WHERE id = $1 AND class_id = $2', [b.subjectId, req.scope.classId])).rows[0];
    if (!subj) throw badRequest('INVALID_SUBJECT', 'That subject is not part of your class');
    const last = (await c.query('SELECT attempt, is_pass, verification_status FROM marks WHERE student_id = $1 AND subject_id = $2 ORDER BY attempt DESC LIMIT 1', [req.user.id, b.subjectId])).rows[0];
    let attempt = 1;
    if (last) {
      if (last.verification_status !== 'verified') throw new AppError(409, 'RECORD_EXISTS', 'You already have an unverified entry for this subject — edit it instead');
      if (last.is_pass) throw new AppError(409, 'RECORD_EXISTS', 'This subject is already passed and verified');
      attempt = last.attempt + 1;                                  // re-attempt of a backlog
    }
    const d = deriveMark(b);
    const ins = (await c.query(
      `INSERT INTO marks (student_id, subject_id, semester, attempt, internal_obtained, internal_max, external_obtained, external_max,
                          grade, grade_points, is_pass, source, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'student','pending') RETURNING *`,
      [req.user.id, b.subjectId, subj.semester, attempt, b.internalObtained, b.internalMax, b.externalObtained, b.externalMax, d.grade, d.gradePoints, d.pass])).rows[0];
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'marks', entityId: ins.id });
    return ins;
  });
  res.status(201).json({ claim: mapClaimRow(row) });
}));

// PATCH /student/academics/claims/:id — correct a pending / rejected claim and resubmit
router.patch('/claims/:id', validate({ params: idParam, body: claimPatchBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    const d = deriveMark(b);
    const upd = (await c.query(
      `UPDATE marks SET internal_obtained = $3, internal_max = $4, external_obtained = $5, external_max = $6,
              grade = $7, grade_points = $8, is_pass = $9, verification_status = 'pending', verified_by = NULL, verified_at = NULL
        WHERE id = $1 AND student_id = $2 AND source = 'student' AND verification_status <> 'verified' RETURNING *`,
      [req.params.id, req.user.id, b.internalObtained, b.internalMax, b.externalObtained, b.externalMax, d.grade, d.gradePoints, d.pass])).rows[0];
    if (!upd) throw notFound('Claim');
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'marks', entityId: upd.id });
    return upd;
  });
  res.json({ claim: mapClaimRow(row) });
}));

module.exports = router;
