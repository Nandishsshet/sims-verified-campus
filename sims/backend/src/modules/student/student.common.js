'use strict';
const { forbidden } = require('../../utils/errors');
const { protect } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { z } = require('zod');

/** Student whose class membership has been APPROVED (req.scope.classId is set). */
const requireApprovedStudent = (req, res, next) =>
  req.scope.classId
    ? next()
    : next(forbidden('Join a class and wait for your instructor to approve you first', 'NO_CLASS'));

/** Standard guard stack for student routes. */
const studentOnly = [...protect, requireRole('student')];
const approvedStudentOnly = [...studentOnly, requireApprovedStudent];

/**
 * Put an item into the instructor's verification queue (idempotent: at most one OPEN
 * request per entity, enforced by the partial unique index).
 */
async function submitForVerification(db, { studentId, classId, entityType, entityId, note = null }) {
  await db.query(
    `INSERT INTO verification_requests (class_id, student_id, entity_type, entity_id, student_note)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (entity_type, entity_id) WHERE status = 'pending' DO NOTHING`,
    [classId, studentId, entityType, entityId, note]);
}

/** Remove a deleted item's open requests (entity_id is polymorphic, so no FK cascade). */
async function withdrawRequests(db, entityType, entityId) {
  await db.query(`DELETE FROM verification_requests WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'`, [entityType, entityId]);
}

/**
 * When a student is APPROVED into a class, queue everything they had already submitted
 * (profile, certificates, projects, self-reported marks / attendance) that has no open request.
 */
async function syncOpenRequests(db, studentId, classId) {
  const ins = (type, selectSql) => db.query(
    `INSERT INTO verification_requests (class_id, student_id, entity_type, entity_id)
     ${selectSql} ON CONFLICT (entity_type, entity_id) WHERE status = 'pending' DO NOTHING`, [classId, studentId]);
  await ins('profile', `SELECT $1::uuid, $2::uuid, 'profile'::verifiable_entity, user_id FROM student_profiles WHERE user_id = $2 AND verification_status = 'pending'`);
  await ins('certificate', `SELECT $1::uuid, $2::uuid, 'certificate'::verifiable_entity, id FROM certificates WHERE student_id = $2 AND verification_status = 'pending'`);
  await ins('project', `SELECT $1::uuid, $2::uuid, 'project'::verifiable_entity, id FROM portfolio_items WHERE student_id = $2 AND verification_status = 'pending'`);
  await ins('marks', `SELECT $1::uuid, $2::uuid, 'marks'::verifiable_entity, id FROM marks WHERE student_id = $2 AND source = 'student' AND verification_status = 'pending'`);
  await ins('attendance', `SELECT $1::uuid, $2::uuid, 'attendance'::verifiable_entity, id FROM attendance_records WHERE student_id = $2 AND source = 'student' AND verification_status = 'pending'`);
}

const idParam = z.object({ id: z.string().uuid() });
const skillLinks = z.array(z.object({ skillId: z.string().uuid(), proficiency: z.number().int().min(1).max(5) })).max(10);

/** Replace the skills attached to a certificate / portfolio item. `column` is a fixed internal value. */
async function setEvidenceSkills(db, studentId, column, evidenceId, skills) {
  if (!['certificate_id', 'portfolio_id'].includes(column)) throw new Error('bad column');
  await db.query(`DELETE FROM student_skills WHERE student_id = $1 AND ${column} = $2`, [studentId, evidenceId]);
  const source = column === 'certificate_id' ? 'certificate' : 'project';
  for (const s of skills) {
    await db.query(
      `INSERT INTO student_skills (student_id, skill_id, proficiency, source, ${column}) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`, [studentId, s.skillId, s.proficiency, source, evidenceId]);
  }
}

module.exports = {
  requireApprovedStudent, studentOnly, approvedStudentOnly,
  submitForVerification, withdrawRequests, syncOpenRequests, setEvidenceSkills, idParam, skillLinks,
};
