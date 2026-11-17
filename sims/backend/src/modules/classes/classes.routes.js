'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notify } = require('../../utils/notify');
const { protect } = require('../../middleware/auth');
const { requireRole, requireApprovedInstructor, requireOwnClass } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { shared } = require('../auth/auth.schema');
const keys = require('../keys/keys.service');
const { syncOpenRequests } = require('../student/student.common');

router.use(...protect, requireRole('instructor'), requireApprovedInstructor);

const classParam = z.object({ classId: z.string().uuid() });
const enrollParam = z.object({ classId: z.string().uuid(), eid: z.string().uuid() });
const year = z.number().int().min(1990).max(2100);

const createClassBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  departmentId: shared.uuid,
  branch: z.string().trim().min(2).max(120),
  admissionYear: year,
  passoutYear: year,
  hodName: shared.text(120),
  instructorName: shared.text(120),          // defaults to the account name
  instructorPhone: shared.phone,
  instructorEmail: z.string().trim().toLowerCase().email().optional(),
}).refine((v) => v.passoutYear > v.admissionYear, { path: ['passoutYear'], message: 'Passout year must be after admission year' });

// POST /classes — create a class and receive its Class Key
router.post('/', validate({ body: createClassBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const out = await tx(async (c) => {
    const dept = (await c.query('SELECT id, hod_name FROM departments WHERE id = $1 AND college_id = $2', [b.departmentId, req.scope.collegeId])).rows[0];
    if (!dept) throw badRequest('INVALID_DEPARTMENT', 'That department does not belong to your college');
    const me = (await c.query('SELECT full_name, email, phone FROM users WHERE id = $1', [req.user.id])).rows[0];

    const cls = (await c.query(
      `INSERT INTO classes (college_id, department_id, instructor_id, name, branch, admission_year, passout_year,
                            hod_name, instructor_name, instructor_phone, instructor_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.scope.collegeId, b.departmentId, req.user.id, b.name || `${b.branch} ${b.admissionYear}-${b.passoutYear}`,
        b.branch, b.admissionYear, b.passoutYear, b.hodName || dept.hod_name, b.instructorName || me.full_name,
        b.instructorPhone ?? me.phone, b.instructorEmail ?? me.email])).rows[0];
    const key = await keys.issueKey(c, { scope: 'class', scopeId: cls.id, createdBy: req.user.id });
    await audit(c, { ...ctxOf(req), action: 'class.create', entityType: 'class', entityId: cls.id, classId: cls.id });
    return { cls, key };
  });
  res.status(201).json({ class: out.cls, classKey: out.key.key_value });
}));

// GET /classes — my classes with their current key and request counts
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.branch, c.admission_year, c.passout_year, c.status, c.current_semester,
            k.key_value AS class_key,
            count(e.*) FILTER (WHERE e.status = 'pending')::int  AS pending_requests,
            count(e.*) FILTER (WHERE e.status = 'approved')::int AS students
       FROM classes c
       LEFT JOIN access_keys k ON k.class_id = c.id AND k.status = 'active'
       LEFT JOIN class_enrollments e ON e.class_id = c.id
      WHERE c.id = ANY($1::uuid[])
      GROUP BY c.id, k.key_value ORDER BY c.created_at`, [req.scope.classIds]);
  res.json({ classes: rows });
}));

// GET /classes/:classId
router.get('/:classId', validate({ params: classParam }), requireOwnClass(), asyncHandler(async (req, res) => {
  const cls = (await pool.query(
    `SELECT c.*, d.name AS department_name, col.name AS college_name
       FROM classes c JOIN departments d ON d.id = c.department_id JOIN colleges col ON col.id = c.college_id
      WHERE c.id = $1`, [req.params.classId])).rows[0];
  res.json({ class: cls, key: keys.publicKey(await keys.getActiveKey(pool, 'class', cls.id)) });
}));

// GET /classes/:classId/enrollments?status=pending&q=asha
router.get('/:classId/enrollments',
  validate({ params: classParam, query: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'removed']).optional(), q: z.string().trim().max(80).optional() }) }),
  requireOwnClass(),
  asyncHandler(async (req, res) => {
    const like = req.query.q ? `%${req.query.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    const { rows } = await pool.query(
      `SELECT e.id, e.status, e.roll_number, e.remarks, e.requested_at, e.decided_at,
              u.id AS student_id, u.full_name, u.email, u.phone
         FROM class_enrollments e JOIN users u ON u.id = e.student_id
        WHERE e.class_id = $1
          AND ($2::text IS NULL OR e.status::text = $2)
          AND ($3::text IS NULL OR u.full_name ILIKE $3 OR u.email::text ILIKE $3 OR e.roll_number ILIKE $3)
        ORDER BY (e.status = 'pending') DESC, e.requested_at DESC LIMIT 500`,
      [req.params.classId, req.query.status ?? null, like]);
    res.json({ enrollments: rows });
  }));

/**
 * Enrollment lifecycle (instructor):
 *   pending --approve--> approved        pending --reject--> rejected
 *   approved|pending --remove--> removed (instructor can remove any unwanted student at any time)
 *   rejected|removed --approve--> approved  (change of mind; DB still enforces one live class per student)
 */
const ENROLL = {
  approve: { to: 'approved', from: ['pending', 'rejected', 'removed'] },
  reject: { to: 'rejected', from: ['pending'] },
  remove: { to: 'removed', from: ['approved', 'pending'] },
};
const decisionBody = z.object({ rollNumber: z.string().trim().min(1).max(40).optional(), remarks: z.string().trim().max(500).optional() });

async function decide(req, res, verb) {
  const t = ENROLL[verb];
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE class_enrollments
          SET status = $1, roll_number = COALESCE($2, roll_number), remarks = $3, decided_at = now(), decided_by = $4
        WHERE id = $5 AND class_id = $6 AND status = ANY($7::membership_status[])
        RETURNING id, student_id, status, roll_number`,
      [t.to, req.body?.rollNumber ?? null, req.body?.remarks ?? null, req.user.id, req.params.eid, req.params.classId, t.from]);
    const e = rows[0];
    if (!e) {
      const cur = await c.query('SELECT status FROM class_enrollments WHERE id = $1 AND class_id = $2', [req.params.eid, req.params.classId]);
      if (!cur.rows[0]) throw notFound('Enrollment');
      throw new AppError(409, 'INVALID_STATE', `Cannot ${verb} a student whose status is ${cur.rows[0].status}`);
    }
    // A newly approved student's earlier submissions (profile, certificates, projects…) enter this class's queue
    if (verb === 'approve') await syncOpenRequests(c, e.student_id, req.params.classId);
    await audit(c, { ...ctxOf(req), action: `student.${verb}`, entityType: 'class_enrollments', entityId: e.id,
      classId: req.params.classId, metadata: { studentId: e.student_id, remarks: req.body?.remarks ?? null } });
    await notify(c, e.student_id, {
      type: `enrollment_${t.to}`, title: `Class request ${t.to}`,
      body: req.body?.remarks || (verb === 'approve' ? 'You have been added to the class.' : verb === 'remove' ? 'You were removed from the class.' : 'Your request was declined.'),
      link: '/student',
    });
    return e;
  });
  res.json({ enrollment: out });
}

const base = { params: enrollParam, body: decisionBody };
router.post('/:classId/enrollments/:eid/approve', validate(base), requireOwnClass(), asyncHandler((req, res) => decide(req, res, 'approve')));
router.post('/:classId/enrollments/:eid/reject', validate(base), requireOwnClass(), asyncHandler((req, res) => decide(req, res, 'reject')));
router.delete('/:classId/enrollments/:eid', validate({ params: enrollParam, body: decisionBody.pick({ remarks: true }) }), requireOwnClass(), asyncHandler((req, res) => decide(req, res, 'remove')));

// ---- Phase 4 sub-routers. Each is mounted behind requireOwnClass, so a foreign class id is a 404 everywhere.
router.use('/:classId/verifications', requireOwnClass(), require('./verification.routes'));
router.use('/:classId', requireOwnClass(), require('./setup.routes'));       // subjects, timetable, PATCH class
router.use('/:classId', requireOwnClass(), require('./dataentry.routes'));   // attendance, marks, imports
router.use('/:classId', requireOwnClass(), require('./analytics.routes'));   // students, analytics, leaderboard, exports
router.use('/:classId', requireOwnClass(), require('./life.routes'));        // announcements, activities, assignments, notes, audit

module.exports = router;
