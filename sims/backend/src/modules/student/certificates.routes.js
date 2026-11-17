'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { validate } = require('../../middleware/validate');
const upload = require('../../utils/upload');
const { approvedStudentOnly, submitForVerification, withdrawRequests, setEvidenceSkills, idParam, skillLinks } = require('./student.common');

router.use(...approvedStudentOnly);

const CATEGORIES = ['course', 'hackathon', 'internship', 'sports', 'workshop', 'other'];
const fields = {
  title: z.string().trim().min(2).max(200),
  category: z.enum(CATEGORIES),
  issuer: z.string().trim().min(2).max(200),
  // evaluated per request (a module-level `new Date()` would freeze "today" at server start)
  issueDate: z.coerce.date().refine((d) => d <= new Date(), 'Issue date cannot be in the future').optional(),
  credentialUrl: z.string().trim().url().max(300).refine((u) => /^https?:\/\//i.test(u)).optional(),
};
// multipart bodies carry skills as a JSON string
const skillsField = z.string().optional().transform((s, ctx) => {
  if (!s) return [];
  try { return skillLinks.parse(JSON.parse(s)); } catch { ctx.addIssue({ code: 'custom', message: 'skills must be a JSON array of {skillId, proficiency 1-5}' }); return z.NEVER; }
});
const createBody = z.object({ ...fields, skills: skillsField });
const patchBody = z.object(fields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const dto = (r, skills = []) => ({
  id: r.id, title: r.title, category: r.category, issuer: r.issuer, issueDate: r.issue_date, credentialUrl: r.credential_url,
  status: r.verification_status, remarks: r.verifier_remarks, verifiedAt: r.verified_at, createdAt: r.created_at,
  // QR / verification id is exposed ONLY while the certificate is verified
  verificationCode: r.verification_status === 'verified' ? r.verification_code : null,
  fileType: r.file_path.split('.').pop(),
  skills,
});

async function skillsFor(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT ss.certificate_id, ss.skill_id, ss.proficiency, s.name FROM student_skills ss JOIN skills s ON s.id = ss.skill_id
      WHERE ss.certificate_id = ANY($1::uuid[])`, [ids]);
  const m = new Map();
  for (const r of rows) { if (!m.has(r.certificate_id)) m.set(r.certificate_id, []); m.get(r.certificate_id).push({ skillId: r.skill_id, name: r.name, proficiency: r.proficiency }); }
  return m;
}

// GET /student/certificates
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM certificates WHERE student_id = $1 ORDER BY created_at DESC', [req.user.id]);
  const sk = await skillsFor(rows.map((r) => r.id));
  res.json({ certificates: rows.map((r) => dto(r, sk.get(r.id) || [])) });
}));

// POST /student/certificates  (multipart) — uploading also sends it for verification
router.post('/', upload.singleFile(5 * 1024 * 1024), validate({ body: createBody }), asyncHandler(async (req, res) => {
  const info = upload.inspectUpload(req.file, ['pdf', 'png', 'jpg'], 'certificate');
  const b = req.body;
  if (b.skills.length) {
    const found = await pool.query('SELECT count(*)::int AS n FROM skills WHERE id = ANY($1::uuid[])', [b.skills.map((s) => s.skillId)]);
    if (found.rows[0].n !== new Set(b.skills.map((s) => s.skillId)).size) throw badRequest('INVALID_SKILL', 'One of the selected skills does not exist');
  }
  const rel = await upload.saveFile(req.user.id, req.file.buffer, info.ext);
  try {
    const row = await tx(async (c) => {
      const ins = (await c.query(
        `INSERT INTO certificates (student_id, title, category, issuer, issue_date, credential_url, file_path, file_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.id, b.title, b.category, b.issuer, b.issueDate?.toISOString().slice(0, 10) ?? null, b.credentialUrl ?? null, rel, info.sha256])).rows[0];
      await setEvidenceSkills(c, req.user.id, 'certificate_id', ins.id, b.skills);
      await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'certificate', entityId: ins.id });
      return ins;
    });
    res.status(201).json({ certificate: dto(row, b.skills) });
  } catch (err) {
    await upload.removeFile(rel);          // don't leave orphan files behind (e.g. duplicate upload → 409)
    throw err;
  }
}));

async function ownCert(id, studentId, db = pool) {
  const r = (await db.query('SELECT * FROM certificates WHERE id = $1 AND student_id = $2', [id, studentId])).rows[0];
  if (!r) throw notFound('Certificate');
  return r;
}

// PATCH /student/certificates/:id — any edit sends it back to the instructor
router.patch('/:id', validate({ params: idParam, body: patchBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    await ownCert(req.params.id, req.user.id, c);
    const map = { title: 'title', category: 'category', issuer: 'issuer', issueDate: 'issue_date', credentialUrl: 'credential_url' };
    const sets = []; const vals = [req.params.id];
    for (const [k, col] of Object.entries(map)) if (k in b) { vals.push(k === 'issueDate' ? b[k].toISOString().slice(0, 10) : b[k]); sets.push(`${col} = $${vals.length}`); }
    const upd = (await c.query(
      `UPDATE certificates SET ${sets.join(', ')}, verification_status = 'pending', verified_by = NULL, verified_at = NULL, verifier_remarks = NULL
        WHERE id = $1 RETURNING *`, vals)).rows[0];
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'certificate', entityId: upd.id });
    return upd;
  });
  res.json({ certificate: dto(row, (await skillsFor([row.id])).get(row.id) || []) });
}));

// POST /student/certificates/:id/submit — resubmit after rejection / correction request
router.post('/:id/submit', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const row = await tx(async (c) => {
    const upd = (await c.query(
      `UPDATE certificates SET verification_status = 'pending', verified_by = NULL, verified_at = NULL
        WHERE id = $1 AND student_id = $2 AND verification_status IN ('rejected','correction_requested') RETURNING *`,
      [req.params.id, req.user.id])).rows[0];
    if (!upd) {
      await ownCert(req.params.id, req.user.id, c);
      throw new AppError(409, 'INVALID_STATE', 'Only a rejected certificate (or one needing correction) can be resubmitted');
    }
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'certificate', entityId: upd.id });
    return upd;
  });
  res.json({ certificate: dto(row) });
}));

// PUT /student/certificates/:id/skills — which skills this certificate evidences
router.put('/:id/skills', validate({ params: idParam, body: z.object({ skills: skillLinks }) }), asyncHandler(async (req, res) => {
  await tx(async (c) => {
    await ownCert(req.params.id, req.user.id, c);
    await setEvidenceSkills(c, req.user.id, 'certificate_id', req.params.id, req.body.skills);
  });
  res.json({ skills: req.body.skills });
}));

// DELETE /student/certificates/:id
router.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const cert = await tx(async (c) => {
    const row = await ownCert(req.params.id, req.user.id, c);
    await withdrawRequests(c, 'certificate', row.id);
    await c.query('DELETE FROM certificates WHERE id = $1', [row.id]);      // skills cascade
    return row;
  });
  await upload.removeFile(cert.file_path);
  res.status(204).end();
}));

// GET /student/certificates/:id/file — owner-only download
router.get('/:id/file', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const row = await ownCert(req.params.id, req.user.id);
  const ext = row.file_path.split('.').pop();
  res.type(ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg')
    .set('Content-Disposition', `inline; filename="certificate.${ext}"`)
    .sendFile(upload.resolveStored(row.file_path));
}));

module.exports = router;
