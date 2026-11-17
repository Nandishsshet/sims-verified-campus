'use strict';
/**
 * Verification center — /classes/:classId/verifications
 *
 * Everything a student submits (profile, certificate, project, self-reported marks / attendance,
 * skill) lands in `verification_requests`. The instructor decides here; the decision is written to
 * the item itself, the request row, the audit log and the student's notifications in ONE transaction.
 * Only `verified` items count in analytics, leaderboards and resumes.
 */
const { z } = require('zod');
const router = require('express').Router({ mergeParams: true });
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notify } = require('../../utils/notify');
const { validate } = require('../../middleware/validate');
const upload = require('../../utils/upload');
const { generateVerificationCode } = require('../../utils/keygen');
const { deriveMark } = require('../../services/academics');

// entity type → [table, id column, student column]. Fixed internal values (never user input).
const ENTITY = {
  profile: ['student_profiles', 'user_id', 'user_id'],
  marks: ['marks', 'id', 'student_id'],
  attendance: ['attendance_records', 'id', 'student_id'],
  certificate: ['certificates', 'id', 'student_id'],
  project: ['portfolio_items', 'id', 'student_id'],
  skill: ['student_skills', 'id', 'student_id'],
};
const ACTIONS = {
  verify: { status: 'verified', past: 'verified', title: 'verified' },
  reject: { status: 'rejected', past: 'rejected', title: 'rejected' },
  'request-correction': { status: 'correction_requested', past: 'sent back for correction', title: 'needs correction' },
};
const LABEL = { profile: 'Profile', marks: 'Marks', attendance: 'Attendance', certificate: 'Certificate', project: 'Project', skill: 'Skill' };

const vidParam = z.object({ classId: z.string().uuid(), vid: z.string().uuid() });
const remarks = z.string().trim().min(3, 'Please explain the decision').max(500);

// ---------------------------------------------------------------- summaries of the underlying items
/** One-line description of each request's item, fetched per type in a single query (no N+1). */
async function summarise(db, requests) {
  const ids = (type) => requests.filter((r) => r.entity_type === type).map((r) => r.entity_id);
  const out = new Map();
  const set = (id, v) => out.set(id, v);
  const jobs = [];

  if (ids('certificate').length) jobs.push(db.query('SELECT id, title, issuer, category, issue_date::text AS issue_date FROM certificates WHERE id = ANY($1::uuid[])', [ids('certificate')])
    .then(({ rows }) => rows.forEach((r) => set(r.id, { title: r.title, detail: `${r.issuer} · ${r.category}`, date: r.issue_date }))));
  if (ids('project').length) jobs.push(db.query('SELECT id, title, type, organization FROM portfolio_items WHERE id = ANY($1::uuid[])', [ids('project')])
    .then(({ rows }) => rows.forEach((r) => set(r.id, { title: r.title, detail: [r.type, r.organization].filter(Boolean).join(' · ') }))));
  if (ids('marks').length) jobs.push(db.query(
    `SELECT m.id, m.attempt, m.internal_obtained, m.internal_max, m.external_obtained, m.external_max, s.code, s.name
       FROM marks m JOIN subjects s ON s.id = m.subject_id WHERE m.id = ANY($1::uuid[])`, [ids('marks')])
    .then(({ rows }) => rows.forEach((r) => {
      const d = deriveMark({ internalObtained: Number(r.internal_obtained), internalMax: Number(r.internal_max), externalObtained: Number(r.external_obtained), externalMax: Number(r.external_max) });
      set(r.id, { title: `${r.code} ${r.name}`, detail: `${d.total}/${d.max} (${d.percentage}%) · grade ${d.grade}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}` });
    })));
  if (ids('attendance').length) jobs.push(db.query(
    `SELECT a.id, a.attendance_date::text AS attendance_date, a.period, a.status, a.claim_note, s.code, s.name
       FROM attendance_records a JOIN subjects s ON s.id = a.subject_id WHERE a.id = ANY($1::uuid[])`, [ids('attendance')])
    .then(({ rows }) => rows.forEach((r) => set(r.id, { title: `${r.code} ${r.name}`, detail: `${r.attendance_date} · period ${r.period} · claimed ${r.status}`, date: r.attendance_date }))));
  if (ids('skill').length) jobs.push(db.query(
    `SELECT ss.id, ss.proficiency, k.name FROM student_skills ss JOIN skills k ON k.id = ss.skill_id WHERE ss.id = ANY($1::uuid[])`, [ids('skill')])
    .then(({ rows }) => rows.forEach((r) => set(r.id, { title: r.name, detail: `Claimed level ${r.proficiency}/5` }))));
  for (const r of requests.filter((x) => x.entity_type === 'profile')) set(r.entity_id, { title: 'Profile details', detail: 'Identity, guardian and contact details' });

  await Promise.all(jobs);
  return out;
}

const dto = (r, sum) => ({
  id: r.id, type: r.entity_type, typeLabel: LABEL[r.entity_type], entityId: r.entity_id, status: r.status,
  studentNote: r.student_note, reviewerRemarks: r.reviewer_remarks, submittedAt: r.submitted_at, reviewedAt: r.reviewed_at,
  student: { id: r.student_id, name: r.full_name, rollNumber: r.roll_number },
  summary: sum || { title: '(item no longer exists)', detail: null },
});

// ---------------------------------------------------------------- list
const listQuery = z.object({
  status: z.enum(['pending', 'verified', 'rejected', 'correction_requested', 'all']).default('pending'),
  type: z.enum(Object.keys(ENTITY)).optional(),
  studentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /classes/:classId/verifications?status=pending&type=&studentId=
router.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const q = req.query;
  const where = `r.class_id = $1 AND ($2::text = 'all' OR r.status::text = $2) AND ($3::text IS NULL OR r.entity_type::text = $3) AND ($4::uuid IS NULL OR r.student_id = $4)`;
  const args = [req.params.classId, q.status, q.type ?? null, q.studentId ?? null];
  const [{ rows }, counts] = await Promise.all([
    pool.query(
      `SELECT r.*, u.full_name, e.roll_number FROM verification_requests r
         JOIN users u ON u.id = r.student_id
         LEFT JOIN class_enrollments e ON e.class_id = r.class_id AND e.student_id = r.student_id
        WHERE ${where} ORDER BY (r.status = 'pending') DESC, COALESCE(r.reviewed_at, r.submitted_at) DESC
        LIMIT $5 OFFSET $6`, [...args, q.limit, q.offset]),
    pool.query(
      `SELECT entity_type::text AS type, count(*)::int AS n FROM verification_requests WHERE class_id = $1 AND status = 'pending' GROUP BY 1`, [req.params.classId]),
  ]);
  const sums = await summarise(pool, rows);
  res.json({
    items: rows.map((r) => dto(r, sums.get(r.entity_id))),
    pendingByType: Object.fromEntries(counts.rows.map((c) => [c.type, c.n])),
    pendingTotal: counts.rows.reduce((s, c) => s + c.n, 0),
  });
}));

// ---------------------------------------------------------------- one item with full evidence
async function loadRequest(db, classId, vid, lock = false) {
  const { rows } = await db.query(
    `SELECT r.*, u.full_name, u.email, e.roll_number FROM verification_requests r
       JOIN users u ON u.id = r.student_id
       LEFT JOIN class_enrollments e ON e.class_id = r.class_id AND e.student_id = r.student_id
      WHERE r.id = $1 AND r.class_id = $2 ${lock ? 'FOR UPDATE OF r' : ''}`, [vid, classId]);
  if (!rows[0]) throw notFound('Verification request');
  return rows[0];
}

// GET /classes/:classId/verifications/:vid
router.get('/:vid', validate({ params: vidParam }), asyncHandler(async (req, res) => {
  const r = await loadRequest(pool, req.params.classId, req.params.vid);
  const [table, idCol] = ENTITY[r.entity_type];
  const item = (await pool.query(`SELECT * FROM ${table} WHERE ${idCol} = $1`, [r.entity_id])).rows[0] || null;
  if (item) { delete item.file_path; delete item.file_sha256; }          // never expose storage paths
  const sums = await summarise(pool, [r]);

  // history: earlier decisions on the same item
  const history = (await pool.query(
    `SELECT status, reviewer_remarks, reviewed_at FROM verification_requests
      WHERE entity_type = $1 AND entity_id = $2 AND status <> 'pending' ORDER BY reviewed_at DESC LIMIT 10`, [r.entity_type, r.entity_id])).rows;
  res.json({ request: dto(r, sums.get(r.entity_id)), item, hasFile: r.entity_type === 'certificate' && Boolean(item), history });
}));

// GET /classes/:classId/verifications/:vid/file — certificate file for review (instructor of this class only)
router.get('/:vid/file', validate({ params: vidParam }), asyncHandler(async (req, res) => {
  const r = await loadRequest(pool, req.params.classId, req.params.vid);
  if (r.entity_type !== 'certificate') throw badRequest('NO_FILE', 'This item has no file');
  const cert = (await pool.query('SELECT file_path FROM certificates WHERE id = $1 AND student_id = $2', [r.entity_id, r.student_id])).rows[0];
  if (!cert) throw notFound('File');
  const ext = cert.file_path.split('.').pop();
  res.type(ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg')
    .set('Content-Disposition', `inline; filename="certificate.${ext}"`)
    .sendFile(upload.resolveStored(cert.file_path));
}));

// ---------------------------------------------------------------- decisions
/**
 * Apply one decision inside the caller's transaction.
 * Locks the request row so two instructors/tabs cannot decide the same item twice.
 */
async function decide(c, req, vid, action, note) {
  const a = ACTIONS[action];
  const r = await loadRequest(c, req.params.classId, vid, true);
  if (r.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', `This request was already ${r.status.replace('_', ' ')}`);
  const [table, idCol, studentCol] = ENTITY[r.entity_type];
  const verified = a.status === 'verified';

  // Update the item itself. Guarding on the student id means a request can never touch someone else's row.
  const { rows } = await c.query(
    `UPDATE ${table}
        SET verification_status = $3::verification_status,
            verified_by = CASE WHEN $3::verification_status = 'verified' THEN $4::uuid END,
            verified_at = CASE WHEN $3::verification_status = 'verified' THEN now() END,
            verifier_remarks = $5
      WHERE ${idCol} = $1 AND ${studentCol} = $2 RETURNING *`,
    [r.entity_id, r.student_id, a.status, req.user.id, note ?? null]);
  if (!rows[0]) throw new AppError(410, 'ITEM_GONE', 'The student has withdrawn this item');

  // A verified certificate gets its public QR / verification code (kept if it already had one).
  if (verified && r.entity_type === 'certificate' && !rows[0].verification_code) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateVerificationCode();
      const hit = await c.query('UPDATE certificates SET verification_code = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM certificates WHERE verification_code = $2) RETURNING id', [r.entity_id, code]);
      if (hit.rows[0]) break;
      if (attempt === 4) throw new Error('Could not allocate a verification code');
    }
  }

  await c.query(
    `UPDATE verification_requests SET status = $2, reviewer_id = $3, reviewer_remarks = $4, reviewed_at = now() WHERE id = $1`,
    [r.id, a.status, req.user.id, note ?? null]);

  const sum = (await summarise(c, [r])).get(r.entity_id);
  await audit(c, { ...ctxOf(req), action: `${r.entity_type}.${action === 'request-correction' ? 'request_correction' : action}`, entityType: table, entityId: r.entity_id,
    classId: r.class_id, metadata: { studentId: r.student_id, requestId: r.id, remarks: note ?? null } });
  await notify(c, r.student_id, {
    type: `verification_${a.status}`,
    title: `${LABEL[r.entity_type]} ${a.title}`,
    body: [sum?.title, note].filter(Boolean).join(' — ') || null,
    link: '/student/verification',
  });
  return { id: r.id, status: a.status, type: r.entity_type };
}

const decisionBody = { verify: z.object({ remarks: z.string().trim().max(500).optional() }), other: z.object({ remarks }) };

for (const action of Object.keys(ACTIONS)) {
  router.post(`/:vid/${action}`, validate({ params: vidParam, body: action === 'verify' ? decisionBody.verify : decisionBody.other }), asyncHandler(async (req, res) => {
    const out = await tx((c) => decide(c, req, req.params.vid, action, req.body.remarks));
    res.json({ request: out });
  }));
}

// POST /classes/:classId/verifications/bulk  { ids, action: 'verify' | 'reject' | 'request-correction', remarks? }
// Each item is its own transaction: one stale item must not block the other 49.
router.post('/bulk', validate({
  params: z.object({ classId: z.string().uuid() }),
  body: z.object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(['verify', 'reject', 'request-correction']).default('verify'),
    remarks: z.string().trim().max(500).optional(),
  }).refine((b) => b.action === 'verify' || (b.remarks && b.remarks.length >= 3), { path: ['remarks'], message: 'Please explain the decision' }),
}), asyncHandler(async (req, res) => {
  const done = []; const failed = [];
  for (const id of [...new Set(req.body.ids)]) {
    try { done.push(await tx((c) => decide(c, req, id, req.body.action, req.body.remarks))); }
    catch (e) { failed.push({ id, code: e.code || 'ERROR', message: e.status ? e.message : 'Could not process this item' }); }
  }
  res.json({ done: done.length, failed });
}));

module.exports = router;
module.exports.ENTITY = ENTITY;
