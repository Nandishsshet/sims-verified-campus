'use strict';
/**
 * One call that gathers everything the dashboard, suggestions and badges need, so those
 * endpoints can never disagree with each other (or with the class leaderboard).
 */
const { pool } = require('../../db/pool');
const { computeClassLeaderboard } = require('../leaderboard/leaderboard.service');
const { placementOf } = require('./metrics.service');
const { analyse } = require('../skills/skills.routes');
const { stats, subjectBreakdown } = require('./attendance.service');
const { buildSuggestions, evaluateBadges } = require('../../services/insights');

async function verificationCounts(studentId) {
  const { rows } = await pool.query(
    `SELECT status::text AS status, count(*)::int AS n FROM (
       SELECT verification_status AS status FROM certificates WHERE student_id = $1
       UNION ALL SELECT verification_status FROM portfolio_items WHERE student_id = $1
       UNION ALL SELECT verification_status FROM marks WHERE student_id = $1 AND source = 'student'
       UNION ALL SELECT verification_status FROM attendance_records WHERE student_id = $1 AND source = 'student'
       UNION ALL SELECT verification_status FROM student_profiles WHERE user_id = $1
     ) t GROUP BY status`, [studentId]);
  const c = { pending: 0, verified: 0, rejected: 0, correction_requested: 0 };
  for (const r of rows) c[r.status] = r.n;
  return c;
}

async function buildSummary(studentId, classId) {
  const [lb, counts, cls, gap] = await Promise.all([
    computeClassLeaderboard(pool, classId),
    verificationCounts(studentId),
    pool.query('SELECT current_semester FROM classes WHERE id = $1', [classId]),
    analyse(studentId),
  ]);
  const m = lb.metrics.get(studentId);
  const me = lb.ranked.find((s) => s.id === studentId);
  const subjects = await subjectBreakdown(studentId, classId, cls.rows[0].current_semester);
  const overall = stats(m.attended, m.held);
  const trend = m.academics.trend;
  const sgpaDrop = trend.length >= 2 ? Math.max(0, trend[trend.length - 2].sgpa - trend[trend.length - 1].sgpa) : 0;
  const topGaps = gap ? gap.radar.filter((r) => r.have < r.required).sort((a, b) => b.weight * (1 - b.coveragePct / 100) - a.weight * (1 - a.coveragePct / 100)).map((r) => r.skill) : [];

  const insightMetrics = {
    held: m.held, attendancePct: m.attendancePct, toRecover: overall.toRecover, canMiss: overall.canMiss,
    lowSubjects: subjects.filter((s) => s.alert), activeBacklogs: m.activeBacklogs, sgpaDrop,
    hasTargetRole: m.hasTargetRole, verifiedGapPct: m.verifiedGapPct, topGaps,
    certCount: m.certCount, projectCount: m.projectCount, resumeScore: m.resumeScore,
    rejectedCount: counts.rejected + counts.correction_requested, pendingCount: counts.pending,
    cgpa: m.cgpa, semesterCount: m.semesterCount, rank: me?.rank ?? null, classSize: lb.ranked.length,
  };
  return {
    m, me, lb, counts, subjects, overall, gap, topGaps, insightMetrics,
    placement: placementOf(m),
    suggestions: buildSuggestions(insightMetrics),
    badgeCodes: evaluateBadges(insightMetrics),
  };
}

/** Persist newly earned badges (badges are never taken away once awarded). */
async function awardBadges(studentId, codes) {
  if (!codes.length) return;
  await pool.query(
    `INSERT INTO student_badges (student_id, badge_id) SELECT $1, id FROM badges WHERE code = ANY($2::text[]) ON CONFLICT DO NOTHING`,
    [studentId, codes]);
}

module.exports = { buildSummary, awardBadges, verificationCounts };
