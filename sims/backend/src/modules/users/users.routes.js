'use strict';
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { asyncHandler } = require('../../utils/errors');
const { protect } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const schema = require('../auth/auth.schema');
const auth = require('../auth/auth.service');

router.use(...protect);

/** Human-readable organisation context for the signed-in user (names, not just ids). */
async function contextFor(user, scope) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  switch (user.role) {
    case 'student': {
      const e = await one(
        `SELECT e.status, e.roll_number, c.id AS class_id, c.name AS class_name, d.name AS department,
                col.name AS college, uni.name AS university
           FROM class_enrollments e JOIN classes c ON c.id = e.class_id
           JOIN departments d ON d.id = c.department_id
           JOIN colleges col ON col.id = c.college_id JOIN universities uni ON uni.id = col.university_id
          WHERE e.student_id = $1 AND e.status IN ('pending','approved')`, [user.id]);
      return e ? { status: e.status, rollNumber: e.roll_number, class: { id: e.class_id, name: e.class_name },
        department: e.department, college: e.college, university: e.university } : { status: 'none' };
    }
    case 'instructor': {
      if (!scope.collegeId) return { status: 'none' };
      const c = await one('SELECT col.name AS college, uni.name AS university FROM colleges col JOIN universities uni ON uni.id = col.university_id WHERE col.id = $1', [scope.collegeId]);
      const classes = (await pool.query('SELECT id, name FROM classes WHERE id = ANY($1::uuid[]) ORDER BY created_at', [scope.classIds])).rows;
      return { status: scope.status, college: c.college, university: c.university, classes };
    }
    case 'college_admin': {
      if (!scope.collegeId) return { status: 'none' };
      const c = await one('SELECT col.id, col.name, col.status, uni.name AS university FROM colleges col JOIN universities uni ON uni.id = col.university_id WHERE col.id = $1', [scope.collegeId]);
      return { status: c.status, college: { id: c.id, name: c.name }, university: c.university };
    }
    case 'university_head': {
      if (!scope.universityId) return { status: 'none' };
      const u = await one('SELECT id, name, status FROM universities WHERE id = $1', [scope.universityId]);
      return { status: u.status, university: { id: u.id, name: u.name } };
    }
    default:
      return { status: 'none' };
  }
}

router.get('/', asyncHandler(async (req, res) => {
  const row = (await pool.query('SELECT id, email, role, full_name, phone, avatar_url FROM users WHERE id = $1', [req.user.id])).rows[0];
  res.json({ user: auth.publicUser(row), context: await contextFor(req.user, req.scope) });
}));

router.patch('/', validate({ body: schema.updateMe }), asyncHandler(async (req, res) => {
  const { fullName, phone } = req.body;
  const row = (await pool.query(
    `UPDATE users SET full_name = COALESCE($2, full_name),
            phone = CASE WHEN $3::boolean THEN $4 ELSE phone END
      WHERE id = $1 RETURNING id, email, role, full_name, phone, avatar_url`,
    [req.user.id, fullName ?? null, phone !== undefined, phone ?? null])).rows[0];
  res.json({ user: auth.publicUser(row) });
}));

router.post('/password', validate({ body: schema.changePassword }), asyncHandler(async (req, res) => {
  await auth.changePassword(req.user.id, req.body);
  res.json({ message: 'Password changed. Please sign in again.' });
}));

module.exports = router;
