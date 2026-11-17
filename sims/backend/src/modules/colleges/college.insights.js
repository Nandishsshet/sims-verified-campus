'use strict';
/**
 * College-level view model. One pass loads every approved student of every ACTIVE class of the college
 * (verified-only metrics, the same numbers the students and instructors see), ranks them with the
 * college's default weights, and rolls them up into class / department / college groups.
 *
 *   students → class → department → college      (the same formula at every level, docs/SCORING.md §8)
 *
 * Pure helpers (`summarise`, `classAlert`, `buildInsights`) take plain data so they are unit-tested
 * without a database.
 */
const scoring = require('../../services/scoring');
const { loadMetrics, placementOf } = require('../student/metrics.service');
const { riskOf, ATTENDANCE_THRESHOLD, avg } = require('../classes/class.insights');

const STALE_DAYS = 7;                              // a verification waiting longer than this is "stale"
const EVENT_DONE = ['attended', 'runner_up', 'winner'];

// ------------------------------------------------------------------ weights
const COLS = { marks: 'w_marks', attendance: 'w_attendance', certificates: 'w_certificates', skills: 'w_skills', resume: 'w_resume', activity: 'w_activity' };

/** College default weights (what classes without their own config use), else the system default. */
async function collegeWeights(db, collegeId) {
  const row = (await db.query('SELECT * FROM leaderboard_configs WHERE college_id = $1', [collegeId])).rows[0];
  if (!row) return { weights: { ...scoring.DEFAULT_LEADERBOARD_WEIGHTS }, source: 'default' };
  return { weights: Object.fromEntries(Object.entries(COLS).map(([k, col]) => [k, row[col]])), source: 'college' };
}

// ------------------------------------------------------------------ roll-up (pure)
/**
 * @param students  [{ m, risk, placement, attendedEvent }]  (as produced by loadCollegeView)
 * @returns { students, hasData, coverage, metrics, score, components, weak, risk }
 * A group with no verified marks AND no verified attendance has score = null ("no data yet") — it is
 * listed last on leaderboards rather than ranked as a failure.
 */
function summarise(students) {
  const n = students.length;
  const withMarks = students.filter((s) => s.m.semesterCount > 0);
  const withAtt = students.filter((s) => s.m.held > 0);
  const withRole = students.filter((s) => s.m.hasTargetRole);
  const latestSgpa = (s) => s.m.academics.trend[s.m.academics.trend.length - 1]?.sgpa;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  // Missing data counts as 0 (verified-only): a department that has not entered attendance does not get credit for it.
  const metrics = n === 0 ? null : {
    avgSgpa: scoring.round(mean(withMarks.map(latestSgpa))),
    attendancePct: scoring.round(mean(withAtt.map((s) => s.m.attendancePct))),
    passPct: withMarks.length ? scoring.round((100 * withMarks.filter((s) => s.m.activeBacklogs === 0).length) / withMarks.length) : 0,
    certsPerStudent: scoring.round(students.reduce((a, s) => a + s.m.certCount, 0) / n),
    placementReadiness: scoring.round(mean(students.map((s) => s.placement))),
    skillGapPct: withRole.length ? scoring.round(mean(withRole.map((s) => s.m.verifiedGapPct))) : 100,
    eventParticipationPct: scoring.round((100 * students.filter((s) => s.attendedEvent).length) / n),
  };
  const hasData = withMarks.length > 0 || withAtt.length > 0;
  const scored = metrics && hasData ? scoring.departmentScore(metrics) : { score: null, components: null, weak: [] };
  return {
    students: n, hasData,
    coverage: { withMarks: withMarks.length, withAttendance: withAtt.length, withTargetRole: withRole.length },
    metrics, score: scored.score, components: scored.components, weak: scored.weak,
    risk: Object.fromEntries(['low', 'medium', 'high', 'unknown'].map((b) => [b, students.filter((s) => s.risk.band === b).length])),
  };
}

/** Rank groups by score ↓ (ties share a rank; groups without data come last and are unranked). */
function rankGroups(rows) {
  const sorted = [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(a.name).localeCompare(String(b.name)));
  let prev = null; let rank = 0;
  return sorted.map((r, i) => {
    if (r.score == null) return { ...r, rank: null };
    if (!prev || r.score !== prev.score) rank = i + 1;
    prev = r;
    return { ...r, rank };
  });
}

/** Components of `g` that are more than `gap` points below the college mean. */
function behindCollege(g, college, gap = 10) {
  if (!g.components || !college.components) return [];
  return Object.keys(g.components).filter((k) => college.components[k] - g.components[k] > gap);
}

/**
 * Why a class needs the college's attention. Returns [] when it is fine.
 * @param c  { summary, pendingStale, pendingTotal }
 */
function classAlert(c) {
  const s = c.summary; const reasons = [];
  if (s.students === 0) return reasons;                                        // an empty class is not an alert
  if (!s.hasData) reasons.push('No verified attendance or marks yet');
  else {
    if (s.metrics.attendancePct < ATTENDANCE_THRESHOLD) reasons.push(`Average attendance ${s.metrics.attendancePct}% (below ${ATTENDANCE_THRESHOLD}%)`);
    const atRisk = s.risk.medium + s.risk.high;
    const judged = s.students - s.risk.unknown;
    if (judged > 0 && atRisk / judged >= 0.3) reasons.push(`${atRisk} of ${judged} students at medium or high dropout risk`);
    if (s.metrics.passPct < 70) reasons.push(`Only ${s.metrics.passPct}% of students have no backlog`);
  }
  if (c.pendingStale > 0) reasons.push(`${c.pendingStale} verification${c.pendingStale === 1 ? '' : 's'} waiting more than ${STALE_DAYS} days`);
  return reasons;
}
const alertSeverity = (reasons, s) => (reasons.length >= 2 || (s.metrics && s.metrics.attendancePct < 65) ? 'critical' : 'warning');

const METRIC_LABEL = { avgSgpa: 'average SGPA', attendance: 'attendance', passPct: 'pass rate', certificates: 'certificates', placement: 'placement readiness', skills: 'verified skills', events: 'event participation' };

/**
 * Rule-based insights (no model involved — every line cites the numbers it is based on).
 * @param d { college, departments:[{id,name,summary}], classAlerts:[{...}], pendingInstructors, pending:{total, stale}, emptyDepartments:[name] }
 */
function buildInsights(d) {
  const out = []; const push = (id, severity, title, detail, to) => out.push({ id, severity, title, detail, to: to || null });
  const ranked = rankGroups(d.departments.filter((x) => x.summary.score != null).map((x) => ({ ...x, score: x.summary.score })));

  if (d.pendingInstructors > 0) push('instructors_pending', 'warning', `${d.pendingInstructors} instructor request${d.pendingInstructors === 1 ? '' : 's'} waiting`, 'Instructors cannot create classes until you approve them.', '/college/instructors');
  if (d.pending.stale > 0) push('stale_verifications', 'critical', `${d.pending.stale} verification${d.pending.stale === 1 ? '' : 's'} older than ${STALE_DAYS} days`, 'Students are waiting for their classes\' instructors. Unverified work does not count towards any score.', '/college/instructors');
  else if (d.pending.total > 0) push('pending_verifications', 'info', `${d.pending.total} item${d.pending.total === 1 ? '' : 's'} in instructors' verification queues`, 'All are less than a week old.', null);

  if (d.classAlerts.length) push('class_alerts', 'warning', `${d.classAlerts.length} class${d.classAlerts.length === 1 ? '' : 'es'} need attention`, d.classAlerts.slice(0, 3).map((c) => `${c.name}: ${c.reasons[0]}`).join(' · '), '/college/alerts');

  if (ranked.length >= 2) {
    const best = ranked[0]; const worst = ranked[ranked.length - 1];
    push('top_department', 'positive', `${best.name} leads with ${best.score}`, `${worst.name} is lowest at ${worst.score} — a ${scoring.round(best.score - worst.score, 1)}-point gap.`, '/college/departments');
  }
  for (const dep of d.departments) {
    const lag = behindCollege(dep.summary, d.college);
    if (lag.length) {
      const k = lag[0];
      push(`lag_${dep.id}`, 'info', `${dep.name} is behind the college on ${METRIC_LABEL[k]}`, `${dep.summary.components[k]} vs a college average of ${d.college.components[k]}${lag.length > 1 ? ` (and ${lag.length - 1} more metric${lag.length > 2 ? 's' : ''})` : ''}.`, `/college/departments/${dep.id}`);
    }
  }
  if (d.college.metrics && d.college.metrics.eventParticipationPct < 30) push('low_events', 'info', 'Few students attend events', `${d.college.metrics.eventParticipationPct}% of students have attended a published event. Add events from the Events page.`, '/college/events');
  if (d.emptyDepartments.length) push('empty_departments', 'info', `No classes yet in ${d.emptyDepartments.join(', ')}`, 'Instructors choose a department when they create a class.', '/college/departments');
  if (!out.length) push('all_good', 'positive', 'Nothing needs attention', 'No stale verifications, no flagged classes.', null);
  return out;
}

// ------------------------------------------------------------------ loader
/**
 * @returns { weights, source, classes:[{id,name,departmentId,deptName,deptCode,currentSemester,instructorId,instructorName,status}],
 *            students (rank order; each has classId, departmentId, m, risk, placement, attendedEvent, total, components, rank) }
 */
async function loadCollegeView(db, collegeId, { semester = null } = {}) {
  const [classes, studs, done, w] = await Promise.all([
    db.query(
      `SELECT c.id, c.name, c.department_id, c.current_semester, c.instructor_id, c.instructor_name, c.status, d.name AS dept_name, d.code AS dept_code
         FROM classes c JOIN departments d ON d.id = c.department_id WHERE c.college_id = $1 ORDER BY d.name, c.name`, [collegeId]),
    db.query(
      `SELECT e.student_id AS id, u.full_name AS name, e.roll_number, c.id AS class_id, c.department_id
         FROM class_enrollments e JOIN classes c ON c.id = e.class_id JOIN users u ON u.id = e.student_id
        WHERE c.college_id = $1 AND c.status = 'active' AND e.status = 'approved'`, [collegeId]),
    db.query(
      `SELECT DISTINCT p.student_id FROM activity_participants p JOIN activities a ON a.id = p.activity_id
        WHERE a.college_id = $1 AND a.is_published AND p.status = ANY($2::participation_status[])`, [collegeId, EVENT_DONE]),
    collegeWeights(db, collegeId),
  ]);
  const metrics = await loadMetrics(db, studs.rows.map((s) => s.id), { semester });
  const attended = new Set(done.rows.map((r) => r.student_id));

  const ranked = scoring.rankStudents(studs.rows.map((s) => {
    const m = metrics.get(s.id);
    return { id: s.id, name: s.name, rollNumber: s.roll_number, classId: s.class_id, departmentId: s.department_id, components: m.components, cgpa: m.cgpa, attendance: m.attendancePct };
  }), w.weights);
  const students = ranked.map((s) => {
    const m = metrics.get(s.id);
    return { ...s, m, risk: riskOf(m), placement: placementOf(m), attendedEvent: attended.has(s.id), hasData: m.held > 0 || m.semesterCount > 0 };
  });
  return {
    weights: w.weights, source: w.source,
    classes: classes.rows.map((c) => ({ id: c.id, name: c.name, departmentId: c.department_id, deptName: c.dept_name, deptCode: c.dept_code, currentSemester: c.current_semester, instructorId: c.instructor_id, instructorName: c.instructor_name, status: c.status })),
    students,
  };
}

/** Pending verification queue per class: { total, stale, oldestDays }. */
async function pendingByClass(db, collegeId) {
  const { rows } = await db.query(
    `SELECT r.class_id, count(*)::int AS total,
            count(*) FILTER (WHERE r.submitted_at < now() - make_interval(days => $2))::int AS stale,
            floor(extract(epoch FROM (now() - min(r.submitted_at))) / 86400)::int AS oldest_days
       FROM verification_requests r JOIN classes c ON c.id = r.class_id
      WHERE c.college_id = $1 AND r.status = 'pending' GROUP BY r.class_id`, [collegeId, STALE_DAYS]);
  return new Map(rows.map((r) => [r.class_id, { total: r.total, stale: r.stale, oldestDays: r.oldest_days }]));
}

module.exports = { STALE_DAYS, collegeWeights, summarise, rankGroups, behindCollege, classAlert, alertSeverity, buildInsights, loadCollegeView, pendingByClass, avg };
