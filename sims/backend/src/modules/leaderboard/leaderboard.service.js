'use strict';
/**
 * Class leaderboard. Reused by the student view now and by the instructor (Phase 4) and
 * college (Phase 5) dashboards later.
 */
const scoring = require('../../services/scoring');
const { loadMetrics } = require('../student/metrics.service');

const COLS = { marks: 'w_marks', attendance: 'w_attendance', certificates: 'w_certificates', skills: 'w_skills', resume: 'w_resume', activity: 'w_activity' };

/** Weights for a class: its own config → its college's default → system default (35/15/15/15/10/10). */
async function getWeights(db, classId) {
  const own = await db.query('SELECT * FROM leaderboard_configs WHERE class_id = $1', [classId]);
  const row = own.rows[0] || (await db.query(
    `SELECT lc.* FROM leaderboard_configs lc JOIN classes c ON c.college_id = lc.college_id WHERE c.id = $1`, [classId])).rows[0];
  if (!row) return { weights: { ...scoring.DEFAULT_LEADERBOARD_WEIGHTS }, source: 'default' };
  return { weights: Object.fromEntries(Object.entries(COLS).map(([k, col]) => [k, row[col]])), source: row.class_id ? 'class' : 'college' };
}

/** @returns {{weights, source, ranked:Array, metrics:Map}} ranked = rankStudents output (with rank, total, components) */
async function computeClassLeaderboard(db, classId, { semester = null } = {}) {
  const students = (await db.query(
    `SELECT e.student_id AS id, u.full_name AS name, e.roll_number
       FROM class_enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.class_id = $1 AND e.status = 'approved'`, [classId])).rows;
  const metrics = await loadMetrics(db, students.map((s) => s.id), { semester });
  const { weights, source } = await getWeights(db, classId);
  const ranked = scoring.rankStudents(
    students.map((s) => ({ id: s.id, name: s.name, rollNumber: s.roll_number, components: metrics.get(s.id).components, cgpa: metrics.get(s.id).cgpa, attendance: metrics.get(s.id).attendancePct })),
    weights);
  return { weights, source, ranked, metrics };
}

module.exports = { getWeights, computeClassLeaderboard };
