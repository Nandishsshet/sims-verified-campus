'use strict';
/**
 * Class-level view model: one leaderboard computation (verified-only metrics for every approved student)
 * plus per-student risk and placement readiness. The instructor dashboards (this phase) and the
 * college / university roll-ups (later phases) all start from here, so a student's numbers are the
 * same everywhere.
 */
const scoring = require('../../services/scoring');
const { computeClassLeaderboard } = require('../leaderboard/leaderboard.service');
const { placementOf } = require('../student/metrics.service');

const ATTENDANCE_THRESHOLD = 75;

/**
 * Dropout-risk heuristic (see docs/SCORING.md §Dropout risk). With no verified attendance AND no verified
 * marks there is nothing to judge, so the band is 'unknown' rather than a misleading 'high'.
 */
function riskOf(m) {
  const trend = m.academics.trend;
  if (m.held === 0 && trend.length === 0) return { score: null, band: 'unknown', reasons: ['No verified attendance or marks yet'] };
  const sgpa = trend.length ? trend[trend.length - 1].sgpa : 7;                 // neutral when absent
  const prev = trend.length >= 2 ? trend[trend.length - 2].sgpa : null;
  const r = scoring.dropoutRisk({ attendancePct: m.held ? m.attendancePct : 85, sgpa, prevSgpa: prev, backlogs: m.activeBacklogs, activityScore: m.activityScore });

  const reasons = [];
  if (m.held > 0 && m.attendancePct < ATTENDANCE_THRESHOLD) reasons.push(`Attendance ${m.attendancePct}% (below ${ATTENDANCE_THRESHOLD}%)`);
  if (m.activeBacklogs > 0) reasons.push(`${m.activeBacklogs} active backlog${m.activeBacklogs > 1 ? 's' : ''}`);
  if (trend.length && sgpa < 5) reasons.push(`Latest SGPA ${sgpa}`);
  if (prev != null && prev - sgpa >= 0.5) reasons.push(`SGPA fell by ${scoring.round(prev - sgpa)}`);
  return { score: r.score, band: r.band, reasons };
}

/**
 * @returns {{ weights, source, students: Array }} students are in rank order. Each carries `m`
 *   (the full metrics object), `risk` and `placement`.
 */
async function loadClassView(db, classId, { semester = null } = {}) {
  const lb = await computeClassLeaderboard(db, classId, { semester });
  const students = lb.ranked.map((s) => {
    const m = lb.metrics.get(s.id);
    return {
      id: s.id, name: s.name, rollNumber: s.rollNumber, rank: s.rank, total: s.total, components: s.components,
      hasData: m.held > 0 || m.semesterCount > 0, m, risk: riskOf(m), placement: placementOf(m),
    };
  });
  return { weights: lb.weights, source: lb.source, students };
}

const avg = (xs) => (xs.length ? scoring.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Count values into labelled buckets: edges [a,b,c] → "<a", "a–b", "b–c", "≥c". */
function bucketise(values, edges, fmt = (x) => x) {
  const labels = [`<${fmt(edges[0])}`, ...edges.slice(0, -1).map((e, i) => `${fmt(e)}–${fmt(edges[i + 1])}`), `${fmt(edges[edges.length - 1])}+`];
  const counts = labels.map(() => 0);
  for (const v of values) {
    let i = edges.findIndex((e) => v < e);
    if (i === -1) i = edges.length;
    counts[i] += 1;
  }
  return labels.map((label, i) => ({ label, count: counts[i] }));
}

module.exports = { ATTENDANCE_THRESHOLD, riskOf, loadClassView, avg, bucketise };
