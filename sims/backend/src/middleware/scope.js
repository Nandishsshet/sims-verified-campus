'use strict';
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/errors');

/**
 * Resolve the caller's data scope from the database (never from the client).
 *
 * req.scope = {
 *   role, userId,
 *   universityId, collegeId,          // null when the user has no (live) membership
 *   classId,                          // student: their APPROVED class
 *   classIds,                         // instructor: classes they own (only if approved)
 *   status,                           // org status (college/university) or membership status
 * }
 * Every repository query must take its filters from here.
 */
async function resolveScope(user) {
  const base = { role: user.role, userId: user.id, universityId: null, collegeId: null, classId: null, classIds: [], status: null };

  switch (user.role) {
    case 'student': {
      const { rows } = await pool.query(
        `SELECT e.class_id, e.status, c.college_id, col.university_id
           FROM class_enrollments e
           JOIN classes c ON c.id = e.class_id
           JOIN colleges col ON col.id = c.college_id
          WHERE e.student_id = $1 AND e.status IN ('pending','approved')`, [user.id]);
      const e = rows[0];
      if (!e) return { ...base, status: 'none' };
      if (e.status === 'pending') return { ...base, status: 'pending', pendingClassId: e.class_id };
      return { ...base, status: 'approved', classId: e.class_id, collegeId: e.college_id, universityId: e.university_id };
    }

    case 'instructor': {
      const { rows } = await pool.query(
        `SELECT ci.college_id, ci.status, col.university_id, col.status AS college_status
           FROM college_instructors ci JOIN colleges col ON col.id = ci.college_id
          WHERE ci.user_id = $1 AND ci.status IN ('pending','approved')`, [user.id]);
      const m = rows[0];
      if (!m) return { ...base, status: 'none' };
      const scope = { ...base, status: m.status, collegeId: m.college_id, universityId: m.university_id, collegeStatus: m.college_status };
      if (m.status === 'approved') {
        const c = await pool.query(
          `SELECT id FROM classes WHERE instructor_id = $1 AND college_id = $2 AND status <> 'suspended'`,
          [user.id, m.college_id]);
        scope.classIds = c.rows.map((r) => r.id);
      }
      return scope;
    }

    case 'college_admin': {
      const { rows } = await pool.query(
        'SELECT id, university_id, status FROM colleges WHERE admin_user_id = $1', [user.id]);
      const c = rows[0];
      return c ? { ...base, collegeId: c.id, universityId: c.university_id, status: c.status } : { ...base, status: 'none' };
    }

    case 'university_head': {
      const { rows } = await pool.query('SELECT id, status FROM universities WHERE head_user_id = $1', [user.id]);
      const u = rows[0];
      return u ? { ...base, universityId: u.id, status: u.status } : { ...base, status: 'none' };
    }

    default:
      return { ...base, status: 'none' };
  }
}

const loadScope = asyncHandler(async (req, res, next) => {
  req.scope = await resolveScope(req.user);
  next();
});

module.exports = { loadScope, resolveScope };
