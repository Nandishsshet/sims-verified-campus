'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notify } = require('../../utils/notify');
const { validate } = require('../../middleware/validate');
const { shared } = require('../auth/auth.schema');
const upload = require('../../utils/upload');
const { studentOnly, approvedStudentOnly, submitForVerification } = require('./student.common');

const httpsUrl = z.string().trim().url().max(300).refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link');
const patchBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: shared.phone.nullable(),
  dateOfBirth: z.coerce.date().refine((d) => d <= new Date(), 'Date of birth cannot be in the future').nullable(),
  gender: z.enum(['female', 'male', 'other']).nullable(),
  address: z.string().trim().max(500).nullable(),
  guardianName: z.string().trim().max(120).nullable(),
  guardianEmail: z.string().trim().toLowerCase().email().nullable(),
  guardianPhone: shared.phone.nullable(),
  summary: z.string().trim().max(800).nullable(),
  linkedinUrl: httpsUrl.nullable(),
  githubUrl: httpsUrl.nullable(),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// Changing these identity facts invalidates the instructor's earlier verification.
const VERIFIED_FIELDS = ['dateOfBirth', 'gender', 'address', 'guardianName', 'guardianEmail', 'guardianPhone'];

async function loadProfile(userId) {
  const { rows } = await pool.query(
    `SELECT u.full_name, u.email, u.phone, u.avatar_url, p.*,
            e.roll_number, c.id AS class_id, c.name AS class_name, c.branch, c.admission_year, c.passout_year,
            c.hod_name, c.instructor_name, c.current_semester, d.name AS department, col.name AS college, uni.name AS university
       FROM users u
       JOIN student_profiles p ON p.user_id = u.id
       LEFT JOIN class_enrollments e ON e.student_id = u.id AND e.status = 'approved'
       LEFT JOIN classes c ON c.id = e.class_id
       LEFT JOIN departments d ON d.id = c.department_id
       LEFT JOIN colleges col ON col.id = c.college_id
       LEFT JOIN universities uni ON uni.id = col.university_id
      WHERE u.id = $1`, [userId]);
  const r = rows[0];
  if (!r) throw notFound('Profile');
  return {
    profile: {
      fullName: r.full_name, email: r.email, phone: r.phone, hasPhoto: Boolean(r.avatar_url),
      dateOfBirth: r.date_of_birth, gender: r.gender, address: r.address,
      guardianName: r.guardian_name, guardianEmail: r.guardian_email, guardianPhone: r.guardian_phone,
      summary: r.summary, linkedinUrl: r.linkedin_url, githubUrl: r.github_url,
      verification: { status: r.verification_status, remarks: r.verifier_remarks, verifiedAt: r.verified_at },
    },
    academic: r.class_id ? {
      rollNumber: r.roll_number, classId: r.class_id, className: r.class_name, branch: r.branch, department: r.department,
      admissionYear: r.admission_year, passoutYear: r.passout_year, currentSemester: r.current_semester,
      hodName: r.hod_name, instructorName: r.instructor_name, college: r.college, university: r.university,
    } : null,
  };
}

// GET /student/profile
router.get('/', ...studentOnly, asyncHandler(async (req, res) => res.json(await loadProfile(req.user.id))));

// PATCH /student/profile
router.patch('/', ...studentOnly, validate({ body: patchBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const resetsVerification = VERIFIED_FIELDS.some((f) => f in b);
  await tx(async (c) => {
    if ('fullName' in b || 'phone' in b) {
      await c.query(`UPDATE users SET full_name = COALESCE($2, full_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END WHERE id = $1`,
        [req.user.id, b.fullName ?? null, 'phone' in b, b.phone ?? null]);
    }
    const map = { dateOfBirth: 'date_of_birth', gender: 'gender', address: 'address', guardianName: 'guardian_name', guardianEmail: 'guardian_email',
      guardianPhone: 'guardian_phone', summary: 'summary', linkedinUrl: 'linkedin_url', githubUrl: 'github_url' };
    const sets = []; const vals = [req.user.id];
    for (const [k, col] of Object.entries(map)) if (k in b) { vals.push(b[k]); sets.push(`${col} = $${vals.length}`); }   // col names come from the fixed map above
    if (resetsVerification) sets.push(`verification_status = 'pending'`, 'verified_by = NULL', 'verified_at = NULL', 'verifier_remarks = NULL');
    if (sets.length) await c.query(`UPDATE student_profiles SET ${sets.join(', ')} WHERE user_id = $1`, vals);
    if (resetsVerification && req.scope.classId) {
      await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'profile', entityId: req.user.id });
    }
  });
  res.json(await loadProfile(req.user.id));
}));

// POST /student/profile/submit — resubmit after a rejection / correction request
router.post('/submit', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE student_profiles SET verification_status = 'pending', verified_by = NULL, verified_at = NULL
        WHERE user_id = $1 AND verification_status IN ('rejected','correction_requested') RETURNING user_id`, [req.user.id]);
    if (!rows[0]) throw new AppError(409, 'INVALID_STATE', 'Only a rejected profile (or one needing correction) can be resubmitted');
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'profile', entityId: req.user.id });
  });
  res.json(await loadProfile(req.user.id));
}));

// POST /student/profile/photo  (multipart: file = JPG/PNG ≤ 1 MB)
router.post('/photo', ...studentOnly, upload.singleFile(1024 * 1024), asyncHandler(async (req, res) => {
  const info = upload.inspectUpload(req.file, ['png', 'jpg'], 'photo');
  const rel = await upload.saveFile(req.user.id, req.file.buffer, info.ext);
  const old = (await pool.query('UPDATE users SET avatar_url = $2 WHERE id = $1 RETURNING (SELECT avatar_url FROM users WHERE id = $1) AS prev', [req.user.id, rel])).rows[0];
  if (old?.prev && old.prev !== rel) await upload.removeFile(old.prev);
  res.status(201).json({ hasPhoto: true });
}));

// GET /student/profile/photo — authenticated (an <img src> can't send headers, so the SPA fetches a blob)
router.get('/photo', ...studentOnly, asyncHandler(async (req, res) => {
  const row = (await pool.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!row?.avatar_url) throw notFound('Photo');
  res.set('Cache-Control', 'private, max-age=300').sendFile(upload.resolveStored(row.avatar_url));
}));

// POST /student/class/leave   (mounted at /student/class by student.routes)
const leave = require('express').Router();
leave.post('/leave', ...studentOnly, asyncHandler(async (req, res) => {
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE class_enrollments SET status = 'removed', remarks = 'Left by student', decided_at = now(), decided_by = $1
        WHERE student_id = $1 AND status IN ('pending','approved') RETURNING id, class_id`, [req.user.id]);
    const e = rows[0];
    if (!e) throw new AppError(409, 'NOT_IN_CLASS', 'You are not in a class');
    await c.query(`DELETE FROM verification_requests WHERE student_id = $1 AND class_id = $2 AND status = 'pending'`, [req.user.id, e.class_id]);
    const cls = (await c.query('SELECT name, instructor_id, college_id FROM classes WHERE id = $1', [e.class_id])).rows[0];
    await notify(c, cls.instructor_id, { type: 'student_left', title: 'A student left your class', body: `${req.user.fullName} left ${cls.name}.`, link: `/class/${e.class_id}` });
    await audit(c, { ...ctxOf(req), action: 'student.leave', entityType: 'class_enrollments', entityId: e.id, classId: e.class_id, collegeId: cls.college_id });
    return e;
  });
  res.json({ left: true, classId: out.class_id });
}));

module.exports = { router, leave, loadProfile };
