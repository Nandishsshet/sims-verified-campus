'use strict';
/**
 * University-level view model: ONE pass loads every approved student of every ACTIVE class of every ACTIVE
 * college (verified-only metrics — the same numbers students, instructors and college admins see), then rolls
 * them up with the same formula at every level:
 *
 *   students → class → department → college → university        (docs/SCORING.md §8)
 *
 * Colleges are compared on equal terms, so students are ranked with the SYSTEM default leaderboard weights
 * (a college's own default weights only affect its own dashboard).
 * `rollUp` and `buildUniversityInsights` are pure (plain data in, plain data out) and unit-tested without a database.
 */
const scoring = require('../../services/scoring');
const { loadMetrics, placementOf } = require('../student/metrics.service');
const { riskOf } = require('../classes/class.insights');
const { summarise, rankGroups, behindCollege, STALE_DAYS } = require('../colleges/college.insights');

const EVENT_DONE = ['attended', 'runner_up', 'winner'];

/**
 * @returns { colleges:[{id,name,status}], classes, departments, students (rank order) }
 * Only active colleges contribute students; suspended / pending colleges are listed but have no data.
 */
async function loadUniversityView(db, universityId, { semester = null } = {}) {
  const [cols, classes, studs, depts, done] = await Promise.all([
    db.query('SELECT id, name, status FROM colleges WHERE university_id = $1 ORDER BY name', [universityId]),
    db.query(
      `SELECT c.id, c.name, c.college_id, c.department_id, c.admission_year, c.current_semester, c.instructor_name, c.status
         FROM classes c JOIN colleges col ON col.id = c.college_id
        WHERE col.university_id = $1 AND col.status = 'active' ORDER BY c.name`, [universityId]),
    db.query(
      `SELECT e.student_id AS id, u.full_name AS name, c.id AS class_id, c.department_id, c.college_id, c.admission_year
         FROM class_enrollments e JOIN classes c ON c.id = e.class_id JOIN colleges col ON col.id = c.college_id JOIN users u ON u.id = e.student_id
        WHERE col.university_id = $1 AND col.status = 'active' AND c.status = 'active' AND e.status = 'approved'`, [universityId]),
    db.query(
      `SELECT d.id, d.name, d.code, d.college_id FROM departments d JOIN colleges col ON col.id = d.college_id
        WHERE col.university_id = $1 ORDER BY d.name`, [universityId]),
    db.query(
      `SELECT DISTINCT p.student_id FROM activity_participants p JOIN activities a ON a.id = p.activity_id JOIN colleges col ON col.id = a.college_id
        WHERE col.university_id = $1 AND a.is_published AND p.status = ANY($2::participation_status[])`, [universityId, EVENT_DONE]),
  ]);
  const metrics = await loadMetrics(db, studs.rows.map((s) => s.id), { semester });
  const attended = new Set(done.rows.map((r) => r.student_id));

  const ranked = scoring.rankStudents(studs.rows.map((s) => {
    const m = metrics.get(s.id);
    return { id: s.id, name: s.name, classId: s.class_id, departmentId: s.department_id, collegeId: s.college_id, admissionYear: s.admission_year, components: m.components, cgpa: m.cgpa, attendance: m.attendancePct };
  }), scoring.DEFAULT_LEADERBOARD_WEIGHTS);
  const students = ranked.map((s) => {
    const m = metrics.get(s.id);
    return { ...s, m, risk: riskOf(m), placement: placementOf(m), attendedEvent: attended.has(s.id) };
  });
  return {
    colleges: cols.rows,
    classes: classes.rows.map((c) => ({ id: c.id, name: c.name, collegeId: c.college_id, departmentId: c.department_id, admissionYear: c.admission_year, semester: c.current_semester, instructorName: c.instructor_name, status: c.status })),
    departments: depts.rows.map((d) => ({ id: d.id, name: d.name, code: d.code, collegeId: d.college_id })),
    students,
  };
}

/** Pending-verification queue per college: Map<collegeId, { total, stale }>. */
async function pendingByCollege(db, universityId) {
  const { rows } = await db.query(
    `SELECT c.college_id, count(*)::int AS total, count(*) FILTER (WHERE r.submitted_at < now() - make_interval(days => $2))::int AS stale
       FROM verification_requests r JOIN classes c ON c.id = r.class_id JOIN colleges col ON col.id = c.college_id
      WHERE col.university_id = $1 AND r.status = 'pending' GROUP BY c.college_id`, [universityId, STALE_DAYS]);
  return new Map(rows.map((r) => [r.college_id, { total: r.total, stale: r.stale }]));
}

/**
 * Pure roll-up of a loaded view.
 * @param view     result of loadUniversityView (or a hand-built equivalent)
 * @param pending  Map<collegeId, {total, stale}>
 * @param filter   { collegeId?, departmentCode?, admissionYear? }  narrows the student pool (analytics filters)
 */
function rollUp(view, pending = new Map(), filter = {}) {
  const deptOf = new Map(view.departments.map((d) => [d.id, d]));
  const keep = (s) => (!filter.collegeId || s.collegeId === filter.collegeId)
    && (!filter.departmentCode || deptOf.get(s.departmentId)?.code === filter.departmentCode)
    && (!filter.admissionYear || s.admissionYear === filter.admissionYear);
  const pool = view.students.filter(keep);

  const colleges = view.colleges.map((c) => {
    const mine = pool.filter((s) => s.collegeId === c.id);
    const p = pending.get(c.id) || { total: 0, stale: 0 };
    return {
      id: c.id, name: c.name, status: c.status, summary: summarise(mine), pending: p,
      departments: view.departments.filter((d) => d.collegeId === c.id).length,
      classes: view.classes.filter((x) => x.collegeId === c.id && x.status === 'active').length,
    };
  });
  const departments = view.departments.filter((d) => view.colleges.find((c) => c.id === d.collegeId)?.status === 'active').map((d) => ({
    id: d.id, name: d.name, code: d.code, collegeId: d.collegeId, college: view.colleges.find((c) => c.id === d.collegeId)?.name,
    summary: summarise(pool.filter((s) => s.departmentId === d.id)),
  })).filter((d) => d.summary.students > 0 || !Object.values(filter).some(Boolean));   // when filtering, hide departments with nobody in the pool
  const years = [...new Set(pool.map((s) => s.admissionYear))].sort((a, b) => a - b);
  const cohorts = years.map((year) => {
    const mine = pool.filter((s) => s.admissionYear === year);
    return { year, summary: summarise(mine), colleges: new Set(mine.map((s) => s.collegeId)).size };
  });
  return { university: summarise(pool), colleges, departments, cohorts, pool };
}

/** Semester → average SGPA for a pool of students (the trend line of the analytics page). */
function sgpaTrend(pool) {
  const bySem = new Map();
  for (const s of pool) for (const t of s.m.academics.trend) { if (!bySem.has(t.semester)) bySem.set(t.semester, []); bySem.get(t.semester).push(t.sgpa); }
  return [...bySem.entries()].sort((a, b) => a[0] - b[0]).map(([semester, v]) => ({ semester, avgSgpa: scoring.round(v.reduce((a, b) => a + b, 0) / v.length), students: v.length }));
}

const METRIC_LABEL = { avgSgpa: 'average SGPA', attendance: 'attendance', passPct: 'pass rate', certificates: 'certificates', placement: 'placement readiness', skills: 'verified skills', events: 'event participation' };

/**
 * Rule-based insights for the university head (each line cites its numbers; no model involved).
 * @param d { university, colleges:[{id,name,status,summary}], collegeAlerts:[{name,reasons}], pending:{total,stale},
 *            pendingColleges:number, suspendedColleges:number, emptyColleges:[name] }
 */
function buildUniversityInsights(d) {
  const out = []; const push = (id, severity, title, detail, to) => out.push({ id, severity, title, detail, to: to || null });
  const scored = rankGroups(d.colleges.filter((c) => c.summary.score != null).map((c) => ({ ...c, score: c.summary.score })));

  if (d.pendingColleges > 0) push('colleges_pending', 'warning', `${d.pendingColleges} college${d.pendingColleges === 1 ? '' : 's'} waiting for approval`, 'A college cannot issue its College Key or onboard instructors until you approve it.', '/university/colleges');
  if (d.suspendedColleges > 0) push('colleges_suspended', 'info', `${d.suspendedColleges} college${d.suspendedColleges === 1 ? ' is' : 's are'} suspended`, 'Their students and instructors are blocked and their data is excluded from every ranking.', '/university/colleges');
  if (d.pending.stale > 0) push('stale_verifications', 'critical', `${d.pending.stale} verification${d.pending.stale === 1 ? '' : 's'} older than ${STALE_DAYS} days`, 'Unverified work does not count towards any score. Check the colleges flagged below.', '/university/alerts');
  if (d.collegeAlerts.length) push('college_alerts', 'warning', `${d.collegeAlerts.length} college${d.collegeAlerts.length === 1 ? '' : 's'} need${d.collegeAlerts.length === 1 ? 's' : ''} attention`, d.collegeAlerts.slice(0, 3).map((c) => `${c.name}: ${c.reasons[0]}`).join(' · '), '/university/alerts');

  if (scored.length >= 2) {
    const best = scored[0]; const worst = scored[scored.length - 1];
    push('top_college', 'positive', `${best.name} leads with ${best.score}`, `${worst.name} is lowest at ${worst.score} — a ${scoring.round(best.score - worst.score, 1)}-point gap.`, '/university/leaderboard');
  }
  for (const c of d.colleges) {
    const lag = behindCollege(c.summary, d.university);
    if (lag.length) {
      const k = lag[0];
      push(`lag_${c.id}`, 'info', `${c.name} is behind the university on ${METRIC_LABEL[k]}`, `${c.summary.components[k]} vs a university average of ${d.university.components[k]}${lag.length > 1 ? ` (and ${lag.length - 1} more metric${lag.length > 2 ? 's' : ''})` : ''}.`, `/university/colleges/${c.id}`);
    }
  }
  if (d.university.metrics && d.university.metrics.eventParticipationPct < 30) push('low_events', 'info', 'Few students attend events', `${d.university.metrics.eventParticipationPct}% of students have attended a published event.`, null);
  if (d.emptyColleges.length) push('empty_colleges', 'info', `No classes yet in ${d.emptyColleges.join(', ')}`, 'Instructors create classes after the college admin approves them.', '/university/colleges');
  if (!out.length) push('all_good', 'positive', 'Nothing needs attention', 'No pending approvals, no stale verifications, no flagged colleges.', null);
  return out;
}

module.exports = { loadUniversityView, pendingByCollege, rollUp, sgpaTrend, buildUniversityInsights, EVENT_DONE };
