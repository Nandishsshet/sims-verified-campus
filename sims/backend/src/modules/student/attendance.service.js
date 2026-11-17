'use strict';
const { pool } = require('../../db/pool');
const scoring = require('../../services/scoring');

const DEFAULT_THRESHOLD = 75;

const stats = (attended, held, threshold = DEFAULT_THRESHOLD) => ({
  attended, held,
  percentage: scoring.pct(attended, held),
  alert: held > 0 && scoring.pct(attended, held) < threshold,
  canMiss: scoring.classesCanMiss(attended, held, threshold),
  toRecover: scoring.classesToRecover(attended, held, threshold),
});

/**
 * Verified attendance per subject for the student's class. `semester` null = all semesters.
 * Subjects with no verified sessions yet are omitted.
 */
async function subjectBreakdown(studentId, classId, semester, threshold = DEFAULT_THRESHOLD) {
  const { rows } = await pool.query(
    `SELECT s.id, s.code, s.name, s.semester,
            count(a.*) FILTER (WHERE a.status IN ('present','late','excused'))::int AS attended,
            count(a.*)::int AS held
       FROM subjects s
       LEFT JOIN attendance_records a ON a.subject_id = s.id AND a.student_id = $1 AND a.verification_status = 'verified'
      WHERE s.class_id = $2 AND ($3::int IS NULL OR s.semester = $3::int)
      GROUP BY s.id ORDER BY s.semester, s.code`, [studentId, classId, semester]);
  return rows.filter((r) => r.held > 0).map((r) => ({ subjectId: r.id, code: r.code, name: r.name, semester: r.semester, ...stats(r.attended, r.held, threshold) }));
}

module.exports = { DEFAULT_THRESHOLD, stats, subjectBreakdown };
