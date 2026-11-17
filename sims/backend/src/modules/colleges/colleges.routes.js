'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notify } = require('../../utils/notify');
const { protect } = require('../../middleware/auth');
const { requireRole, requireActiveCollege } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const keys = require('../keys/keys.service');

const idParam = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------- /college  (college admin)
const college = require('express').Router();
college.use(...protect, requireRole('college_admin'));

college.get('/', asyncHandler(async (req, res) => {
  if (!req.scope.collegeId) throw notFound('College');
  const c = (await pool.query(
    `SELECT col.id, col.name, col.address, col.affiliation, col.principal_name, col.contact_email,
            col.contact_phone, col.status, uni.name AS university
       FROM colleges col JOIN universities uni ON uni.id = col.university_id WHERE col.id = $1`, [req.scope.collegeId])).rows[0];
  const key = c.status === 'active' ? await keys.getActiveKey(pool, 'college', c.id) : null;
  res.json({ college: c, key: keys.publicKey(key) });
}));

// GET /college/instructors?status=pending
college.get('/instructors', requireActiveCollege,
  validate({ query: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'removed']).optional() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ci.id, ci.status, ci.requested_at, ci.decided_at, ci.department_id, d.name AS department_name,
              u.id AS user_id, u.full_name, u.email, u.phone,
              (SELECT count(*)::int FROM classes c WHERE c.instructor_id = u.id AND c.college_id = ci.college_id) AS class_count,
              (SELECT count(*)::int FROM class_enrollments e JOIN classes c ON c.id = e.class_id
                WHERE c.instructor_id = u.id AND c.college_id = ci.college_id AND e.status = 'approved') AS student_count,
              -- verification workload and speed: pending now, and the median hours to decide over the last 90 days
              (SELECT count(*)::int FROM verification_requests r JOIN classes c ON c.id = r.class_id
                WHERE c.instructor_id = u.id AND c.college_id = ci.college_id AND r.status = 'pending') AS pending_items,
              (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.reviewed_at - r.submitted_at)) / 3600))::numeric, 1)::float8
                 FROM verification_requests r JOIN classes c ON c.id = r.class_id
                WHERE c.instructor_id = u.id AND c.college_id = ci.college_id AND r.reviewer_id = u.id
                  AND r.status <> 'pending' AND r.reviewed_at > now() - interval '90 days') AS turnaround_hours,
              (SELECT max(l.created_at) FROM audit_logs l WHERE l.actor_id = u.id) AS last_active
         FROM college_instructors ci JOIN users u ON u.id = ci.user_id LEFT JOIN departments d ON d.id = ci.department_id
        WHERE ci.college_id = $1 AND ($2::text IS NULL OR ci.status::text = $2)
        ORDER BY (ci.status = 'pending') DESC, ci.requested_at DESC`, [req.scope.collegeId, req.query.status ?? null]);
    res.json({ instructors: rows });
  }));

/**
 * Instructor lifecycle:  pending --approve--> approved --remove--> removed ; pending --reject--> rejected
 * Removing an instructor suspends their classes (so no new students can join and the class
 * leaves their scope); a later re-approval reactivates them.
 */
const INSTRUCTOR_TRANSITIONS = {
  approve: { from: 'pending', to: 'approved' },
  reject: { from: 'pending', to: 'rejected' },
  remove: { from: 'approved', to: 'removed' },
};

for (const [verb, t] of Object.entries(INSTRUCTOR_TRANSITIONS)) {
  college.post(`/instructors/:id/${verb}`, requireActiveCollege, validate({ params: idParam }), asyncHandler(async (req, res) => {
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE college_instructors SET status = $1, decided_at = now(), decided_by = $2
          WHERE id = $3 AND college_id = $4 AND status = $5 RETURNING id, user_id, status`,
        [t.to, req.user.id, req.params.id, req.scope.collegeId, t.from]);
      const m = rows[0];
      if (!m) {
        const e = await c.query('SELECT status FROM college_instructors WHERE id = $1 AND college_id = $2', [req.params.id, req.scope.collegeId]);
        if (!e.rows[0]) throw notFound('Instructor request');
        throw new AppError(409, 'INVALID_STATE', `Cannot ${verb} an instructor who is ${e.rows[0].status}`);
      }
      if (verb === 'remove') {
        await c.query(`UPDATE classes SET status = 'suspended' WHERE instructor_id = $1 AND college_id = $2 AND status = 'active'`, [m.user_id, req.scope.collegeId]);
      } else if (verb === 'approve') {
        await c.query(`UPDATE classes SET status = 'active' WHERE instructor_id = $1 AND college_id = $2 AND status = 'suspended'`, [m.user_id, req.scope.collegeId]);
      }
      await audit(c, { ...ctxOf(req), action: `instructor.${verb}`, entityType: 'college_instructors', entityId: m.id, metadata: { instructorUserId: m.user_id } });
      await notify(c, m.user_id, {
        type: `instructor_${verb}`, title: `Instructor request ${t.to}`,
        body: verb === 'approve' ? 'You can now create classes.' : verb === 'remove' ? 'You were removed from the college.' : 'Your request was declined.',
        link: '/class',
      });
      return m;
    });
    res.json({ membership: result });
  }));
}

// POST /college/departments  — needed before any class can be created
college.post('/departments', requireActiveCollege,
  validate({ body: z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().toUpperCase().min(2).max(12), hodName: z.string().trim().max(120).optional() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'INSERT INTO departments (college_id, name, code, hod_name) VALUES ($1,$2,$3,$4) RETURNING id, name, code, hod_name',
      [req.scope.collegeId, req.body.name, req.body.code, req.body.hodName ?? null]);
    await audit(pool, { ...ctxOf(req), action: 'department.create', entityType: 'department', entityId: rows[0].id });
    res.status(201).json({ department: rows[0] });
  }));

// Phase 5 sub-routers (profile, departments, events, announcements, weights · overview, leaderboards, analytics, alerts, exports)
college.use(require('./college.manage.routes'));
college.use(require('./college.analytics.routes'));

// ---------------------------------------------------------------- GET /departments (college admin + approved instructor)
const departments = require('express').Router();
departments.get('/', ...protect, requireRole('college_admin', 'instructor'), asyncHandler(async (req, res) => {
  if (!req.scope.collegeId) return res.json({ departments: [] });
  const { rows } = await pool.query(
    'SELECT id, name, code, hod_name FROM departments WHERE college_id = $1 ORDER BY name', [req.scope.collegeId]);
  res.json({ departments: rows });
}));

module.exports = { college, departments };
