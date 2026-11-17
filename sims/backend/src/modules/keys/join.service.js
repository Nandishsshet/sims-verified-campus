'use strict';
/**
 * Joining flows. A key only creates a PENDING membership; a human approves it.
 *   instructor --COL key--> college_instructors (pending) --college admin approves--> approved
 *   student    --CLS key--> class_enrollments   (pending) --instructor approves-->    approved
 */
const { pool } = require('../../db/pool');
const { AppError, badRequest } = require('../../utils/errors');
const { notify } = require('../../utils/notify');
const { audit } = require('../../utils/audit');
const { joinWithKey, invalidKey } = require('./keys.service');

/**
 * Create (or revive) an instructor's membership request. Used by instructor signup and
 * by POST /join/instructor. Runs on the caller's transaction client.
 */
async function requestInstructorMembership(client, { userId, userName, collegeId, departmentId = null }) {
  const col = (await client.query('SELECT id, name, status, admin_user_id FROM colleges WHERE id = $1', [collegeId])).rows[0];
  if (!col || col.status !== 'active') throw invalidKey('org_inactive');

  if (departmentId) {
    const d = await client.query('SELECT 1 FROM departments WHERE id = $1 AND college_id = $2', [departmentId, collegeId]);
    if (!d.rows[0]) throw badRequest('INVALID_DEPARTMENT', 'That department does not belong to this college');
  }

  const existing = (await client.query(
    'SELECT id, status FROM college_instructors WHERE college_id = $1 AND user_id = $2', [collegeId, userId])).rows[0];
  if (existing && ['pending', 'approved'].includes(existing.status)) {
    throw new AppError(409, 'ALREADY_MEMBER', `Your membership is already ${existing.status}`);
  }
  // rejected / removed instructors may ask again → back to pending
  const row = existing
    ? (await client.query(
      `UPDATE college_instructors SET status = 'pending', department_id = $2, requested_at = now(), decided_at = NULL, decided_by = NULL
        WHERE id = $1 RETURNING *`, [existing.id, departmentId])).rows[0]
    : (await client.query(
      `INSERT INTO college_instructors (college_id, user_id, department_id) VALUES ($1,$2,$3) RETURNING *`,
      [collegeId, userId, departmentId])).rows[0];

  await notify(client, col.admin_user_id, {
    type: 'instructor_request', title: 'New instructor request',
    body: `${userName} wants to join ${col.name}.`, link: '/college/instructors',
  });
  return { membership: row, college: col };
}

/** POST /join/instructor — an existing instructor account joins a college. */
async function joinCollegeAsInstructor({ user, collegeKey, departmentId, ctx }) {
  return joinWithKey({
    scope: 'college', rawKey: collegeKey, ctx: { ...ctx, userId: user.id },
    work: async (client, key) => {
      const { membership, college } = await requestInstructorMembership(client, {
        userId: user.id, userName: user.fullName, collegeId: key.college_id, departmentId,
      });
      await audit(client, { actorId: user.id, actorRole: user.role, ip: ctx.ip, action: 'instructor.join_request',
        entityType: 'college_instructors', entityId: membership.id, collegeId: college.id });
      return { data: { membershipId: membership.id, status: membership.status, college: { id: college.id, name: college.name } }, userId: user.id };
    },
  });
}

/** POST /join/class — a student redeems a Class Key. */
async function joinClass({ user, classKey, rollNumber, ctx }) {
  return joinWithKey({
    scope: 'class', rawKey: classKey, ctx: { ...ctx, userId: user.id },
    work: async (client, key) => {
      const cls = (await client.query(
        `SELECT c.id, c.name, c.status, c.college_id, c.instructor_id, col.status AS college_status
           FROM classes c JOIN colleges col ON col.id = c.college_id WHERE c.id = $1`, [key.class_id])).rows[0];
      if (!cls || cls.status !== 'active' || cls.college_status !== 'active') throw invalidKey('org_inactive');

      const existing = (await client.query(
        'SELECT id, status, decided_by FROM class_enrollments WHERE class_id = $1 AND student_id = $2', [cls.id, user.id])).rows[0];
      if (existing && ['pending', 'approved'].includes(existing.status)) {
        throw new AppError(409, 'ALREADY_MEMBER', `Your request for this class is already ${existing.status}`);
      }
      // removed BY THE INSTRUCTOR stays blocked; a student who left on their own (decided_by = themself) may rejoin
      if (existing?.status === 'removed' && existing.decided_by !== user.id) {
        throw new AppError(403, 'REMOVED_FROM_CLASS', 'You were removed from this class. Please contact the class instructor.');
      }

      // rejected students may re-request; a student can hold only ONE live enrollment (DB-enforced)
      const enrollment = existing
        ? (await client.query(
          `UPDATE class_enrollments SET status = 'pending', via_key_id = $2, roll_number = $3, remarks = NULL,
                  requested_at = now(), decided_at = NULL, decided_by = NULL WHERE id = $1 RETURNING *`,
          [existing.id, key.id, rollNumber ?? null])).rows[0]
        : (await client.query(
          `INSERT INTO class_enrollments (class_id, student_id, via_key_id, roll_number) VALUES ($1,$2,$3,$4) RETURNING *`,
          [cls.id, user.id, key.id, rollNumber ?? null])).rows[0];

      await notify(client, cls.instructor_id, {
        type: 'join_request', title: 'New join request',
        body: `${user.fullName} requested to join ${cls.name}.`, link: `/class/${cls.id}/requests`,
      });
      await audit(client, { actorId: user.id, actorRole: user.role, ip: ctx.ip, action: 'student.join_request',
        entityType: 'class_enrollments', entityId: enrollment.id, classId: cls.id, collegeId: cls.college_id });
      return { data: { enrollmentId: enrollment.id, status: enrollment.status, class: { id: cls.id, name: cls.name } }, userId: user.id };
    },
  });
}

/** GET /join/status — where am I in the approval chain? */
async function getJoinStatus(user, scope) {
  if (user.role === 'student') {
    const { rows } = await pool.query(
      `SELECT e.status, e.roll_number, e.remarks, c.id AS class_id, c.name AS class_name
         FROM class_enrollments e JOIN classes c ON c.id = e.class_id
        WHERE e.student_id = $1 ORDER BY (e.status IN ('pending','approved')) DESC, e.requested_at DESC LIMIT 1`, [user.id]);
    const e = rows[0];
    return e ? { status: e.status, rollNumber: e.roll_number, remarks: e.remarks, class: { id: e.class_id, name: e.class_name } } : { status: 'none' };
  }
  if (user.role === 'instructor') {
    const { rows } = await pool.query(
      `SELECT ci.status, col.id AS college_id, col.name AS college_name
         FROM college_instructors ci JOIN colleges col ON col.id = ci.college_id
        WHERE ci.user_id = $1 ORDER BY (ci.status IN ('pending','approved')) DESC, ci.requested_at DESC LIMIT 1`, [user.id]);
    const m = rows[0];
    return m ? { status: m.status, college: { id: m.college_id, name: m.college_name } } : { status: 'none' };
  }
  if (!scope.collegeId && !scope.universityId) return { status: 'none' };
  return { status: scope.status };
}

module.exports = { requestInstructorMembership, joinCollegeAsInstructor, joinClass, getJoinStatus };
