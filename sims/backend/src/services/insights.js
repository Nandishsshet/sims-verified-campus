'use strict';
/**
 * Student-facing rule engines (pure): personalised suggestions and gamification badges.
 * Both take the metrics object produced by modules/student/metrics.service.js.
 */

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2, positive: 3 };

/** metrics: see buildSuggestions callers. Returns at most 8 suggestions, most urgent first. */
function buildSuggestions(m) {
  const out = [];
  const push = (id, severity, title, detail, to) => out.push({ id, severity, title, detail, action: to ? { to } : null });

  if (m.held > 0) {
    if (m.attendancePct < 75) {
      push('low_attendance', 'critical', `Attendance is ${m.attendancePct}%`,
        m.toRecover > 0 ? `Attend the next ${m.toRecover} classes in a row to get back to 75%.` : 'Raise it above 75% to stay eligible for exams.', '/student/attendance');
    } else if (m.attendancePct < 80) {
      push('attendance_margin', 'warning', 'Attendance is close to the limit', `You can only miss ${m.canMiss} more class(es) before dropping below 75%.`, '/student/attendance');
    }
    for (const s of (m.lowSubjects || []).slice(0, 2)) {
      push(`low_subject_${s.code}`, 'warning', `${s.name}: ${s.percentage}% attendance`, 'This subject is below 75%.', '/student/attendance');
    }
  }
  if (m.activeBacklogs > 0) push('backlogs', 'warning', `${m.activeBacklogs} active backlog(s)`, 'Clear backlogs first — they lower placement readiness by 5 points each.', '/student/academics');
  if (m.sgpaDrop >= 0.5) push('sgpa_drop', 'warning', 'SGPA dropped last semester', `Down ${m.sgpaDrop.toFixed(2)} points. Check which subjects pulled it down.`, '/student/academics');

  if (!m.hasTargetRole) push('pick_role', 'info', 'Pick a target role', 'Choose a role to see your skill gap and a learning roadmap.', '/student/skill-gap');
  else if (m.verifiedGapPct > 40) {
    push('skill_gap', 'warning', `Verified skill gap is ${m.verifiedGapPct}%`,
      m.topGaps?.length ? `Start with: ${m.topGaps.slice(0, 3).join(', ')}.` : 'Add certificates or projects as evidence.', '/student/skill-gap');
  }
  if (m.certCount === 0) push('no_certs', 'info', 'No verified certificates yet', 'Upload a course or workshop certificate — each verified one raises your leaderboard score.', '/student/certificates');
  if (m.projectCount < 2) push('few_projects', 'info', 'Add projects', 'Two or more verified projects make a resume much stronger.', '/student/portfolio');
  if (m.resumeScore == null) push('no_resume', 'info', 'Build your resume', 'Your resume is auto-filled from verified data.', '/student/resume');
  else if (m.resumeScore < 60) push('weak_resume', 'warning', `ATS score is ${m.resumeScore}/100`, 'Open the resume builder for specific fixes.', '/student/resume');

  if (m.rejectedCount > 0) push('rejected', 'warning', `${m.rejectedCount} item(s) need your attention`, 'Your instructor rejected or asked for corrections.', '/student/verification');
  if (m.pendingCount > 0) push('pending', 'info', `${m.pendingCount} item(s) awaiting verification`, 'Only verified data counts towards rankings and your resume.', '/student/verification');

  if (!out.length) push('on_track', 'positive', 'You are on track', 'Nothing urgent. Keep your certificates and projects up to date.', null);
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).slice(0, 8);
}

const BADGE_RULES = {
  FIRST_CERT: (m) => m.certCount >= 1,
  CERT_COLLECTOR: (m) => m.certCount >= 5,
  ATTENDANCE_90: (m) => m.held >= 20 && m.attendancePct >= 90,
  SCHOLAR: (m) => m.cgpa >= 8,
  ALL_CLEAR: (m) => m.semesterCount >= 1 && m.activeBacklogs === 0,
  BUILDER: (m) => m.projectCount >= 3,
  SKILL_STAR: (m) => m.hasTargetRole && m.verifiedGapPct <= 20,
  RESUME_PRO: (m) => (m.resumeScore ?? 0) >= 80,
  PODIUM: (m) => m.classSize >= 5 && m.rank != null && m.rank <= 3,
};

/** @returns {string[]} badge codes the student currently qualifies for */
const evaluateBadges = (m) => Object.entries(BADGE_RULES).filter(([, test]) => test(m)).map(([code]) => code);

module.exports = { buildSuggestions, evaluateBadges, BADGE_CODES: Object.keys(BADGE_RULES) };
