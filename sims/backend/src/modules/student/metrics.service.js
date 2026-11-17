'use strict';
/**
 * Bulk metric loader — THE place where "verified-only" is enforced for analytics.
 *
 * Given a list of student ids it runs a handful of set-based queries (no N+1) and returns,
 * per student, every number the dashboards, leaderboards, badges and placement score need.
 * One student (dashboard) and a whole class (leaderboard) go through the same code, so the
 * numbers can never disagree.
 */
const scoring = require('../../services/scoring');
const { computeAcademics } = require('../../services/academics');

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};

/**
 * @param db         pool or client
 * @param studentIds uuid[]
 * @param opts.semester  restrict marks + attendance to one semester (leaderboard filter)
 * @returns Map<studentId, Metrics>
 */
async function loadMetrics(db, studentIds, { semester = null } = {}) {
  const out = new Map();
  if (!studentIds.length) return out;
  const ids = studentIds;

  const [marks, att, certs, port, targets, owned, resumes, acts] = await Promise.all([
    db.query(
      `SELECT m.student_id, m.subject_id, m.semester, m.attempt, m.grade_points, m.is_pass, s.credits, s.code, s.name
         FROM marks m JOIN subjects s ON s.id = m.subject_id
        WHERE m.student_id = ANY($1::uuid[]) AND m.verification_status = 'verified'`, [ids]),
    db.query(
      `SELECT a.student_id,
              count(*) FILTER (WHERE a.status IN ('present','late','excused'))::int AS attended,
              count(*)::int AS held
         FROM attendance_records a JOIN subjects s ON s.id = a.subject_id
        WHERE a.student_id = ANY($1::uuid[]) AND a.verification_status = 'verified'
          AND ($2::int IS NULL OR s.semester = $2::int)
        GROUP BY a.student_id`, [ids, semester]),
    db.query(`SELECT student_id, category FROM certificates WHERE student_id = ANY($1::uuid[]) AND verification_status = 'verified'`, [ids]),
    db.query(
      `SELECT student_id, type, count(*)::int AS n FROM portfolio_items
        WHERE student_id = ANY($1::uuid[]) AND verification_status = 'verified' GROUP BY student_id, type`, [ids]),
    db.query('SELECT student_id, role_id FROM student_target_roles WHERE student_id = ANY($1::uuid[])', [ids]),
    // A skill counts as verified only when its EVIDENCE is verified (certificate / project) —
    // self-declared (manual) skills are never verified-by-evidence.
    db.query(
      `SELECT ss.student_id, ss.skill_id, ss.proficiency,
              COALESCE(CASE ss.source
                         WHEN 'manual' THEN ss.verification_status = 'verified'
                         WHEN 'certificate' THEN c.verification_status = 'verified'
                         ELSE p.verification_status = 'verified' END, false) AS verified
         FROM student_skills ss
         LEFT JOIN certificates c ON c.id = ss.certificate_id
         LEFT JOIN portfolio_items p ON p.id = ss.portfolio_id
        WHERE ss.student_id = ANY($1::uuid[])`, [ids]),
    db.query(
      `SELECT DISTINCT ON (student_id) student_id, ats_score FROM resumes
        WHERE student_id = ANY($1::uuid[]) AND ats_score IS NOT NULL ORDER BY student_id, updated_at DESC`, [ids]),
    db.query(
      `SELECT p.student_id, p.status FROM activity_participants p JOIN activities a ON a.id = p.activity_id
        WHERE a.is_published AND p.student_id = ANY($1::uuid[])`, [ids]),
  ]);

  const roleIds = [...new Set(targets.rows.map((t) => t.role_id))];
  const roleSkills = roleIds.length
    ? (await db.query('SELECT role_id, skill_id, required_level, weight FROM role_skills WHERE role_id = ANY($1::uuid[])', [roleIds])).rows
    : [];
  const reqByRole = groupBy(roleSkills, 'role_id');

  const marksBy = groupBy(marks.rows, 'student_id');
  const attBy = new Map(att.rows.map((r) => [r.student_id, r]));
  const certsBy = groupBy(certs.rows, 'student_id');
  const portBy = groupBy(port.rows, 'student_id');
  const targetBy = new Map(targets.rows.map((r) => [r.student_id, r.role_id]));
  const ownedBy = groupBy(owned.rows, 'student_id');
  const resumeBy = new Map(resumes.rows.map((r) => [r.student_id, r.ats_score]));
  const actsBy = groupBy(acts.rows, 'student_id');

  for (const id of ids) {
    const academics = computeAcademics(marksBy.get(id) || []);
    const a = attBy.get(id) || { attended: 0, held: 0 };
    const certList = certsBy.get(id) || [];
    const p = Object.fromEntries((portBy.get(id) || []).map((r) => [r.type, r.n]));
    const portfolio = { projects: p.project || 0, internships: p.internship || 0, publications: p.publication || 0 };

    const roleId = targetBy.get(id) || null;
    let readiness = 0; let gap = 100;
    if (roleId) {
      const best = {};
      for (const r of (ownedBy.get(id) || []).filter((x) => x.verified)) best[r.skill_id] = Math.max(best[r.skill_id] || 0, r.proficiency);
      const g = scoring.skillGap((reqByRole.get(roleId) || []).map((r) => ({ skillId: r.skill_id, requiredLevel: r.required_level, weight: Number(r.weight) })), best);
      readiness = g.readinessPct; gap = g.gapPct;
    }

    const sgpaSel = semester ? (academics.semesters.find((s) => s.semester === semester)?.sgpa ?? 0) : null;
    const attendancePct = scoring.pct(a.attended, a.held);
    const certScore = scoring.certificateScore(certList);
    const activityScore = scoring.activityScore(actsBy.get(id) || []);
    const resumeScore = resumeBy.has(id) ? resumeBy.get(id) : null;

    out.set(id, {
      academics,
      cgpa: academics.cgpa,
      creditsDone: academics.creditsDone,
      activeBacklogs: academics.activeBacklogs.length,
      semesterCount: academics.semesters.length,
      attended: a.attended, held: a.held, attendancePct,
      certCount: certList.length, certScore,
      portfolio, portfolioScore: scoring.portfolioScore(portfolio),
      projectCount: portfolio.projects,
      targetRoleId: roleId, hasTargetRole: Boolean(roleId),
      skillReadinessPct: readiness, verifiedGapPct: gap,
      resumeScore,
      activityScore,
      components: {
        marks: scoring.marksScore(semester ? sgpaSel : academics.cgpa),
        attendance: attendancePct,
        certificates: certScore,
        skills: roleId ? scoring.round(100 - gap) : 0,
        resume: resumeScore ?? 0,
        activity: activityScore,
      },
    });
  }
  return out;
}

const placementOf = (m) => scoring.placementReadiness({
  cgpa: m.cgpa, skillReadinessPct: m.skillReadinessPct, certScore: m.certScore, portfolioScore: m.portfolioScore,
  resumeScore: m.resumeScore ?? 0, attendancePct: m.attendancePct, activeBacklogs: m.activeBacklogs,
});

module.exports = { loadMetrics, placementOf };
