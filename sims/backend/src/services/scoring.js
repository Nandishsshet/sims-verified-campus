'use strict';
/**
 * SIMS scoring engine — pure functions, no I/O.
 *
 * Every formula documented in docs/SCORING.md lives here so that the
 * class, college and university dashboards all compute numbers the same
 * way. Callers MUST pass VERIFIED data only; this module does not know
 * about verification status.
 */

// ---------------------------------------------------------------- helpers
const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const round = (x, dp = 2) => Math.round((x + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const sum = (arr, fn = (x) => x) => arr.reduce((s, x) => s + fn(x), 0);

// ------------------------------------------------------------ configuration
const DEFAULT_LEADERBOARD_WEIGHTS = Object.freeze({
  marks: 35, attendance: 15, certificates: 15, skills: 15, resume: 10, activity: 10,
});

const CERT_POINTS = Object.freeze({
  internship: 15, hackathon: 12, course: 8, workshop: 5, sports: 5, other: 3,
});
const CERT_TARGET_POINTS = 50;       // points that earn a 100 certificate score

const ACTIVITY_POINTS = Object.freeze({ registered: 0, attended: 10, runner_up: 18, winner: 25 });
const ACTIVITY_TARGET_POINTS = 60;   // points that earn a 100 activity score

const DEPARTMENT_WEIGHTS = Object.freeze({
  avgSgpa: 25, attendance: 20, passPct: 20, certificates: 10,
  placement: 10, skills: 10, events: 5,
});
const CERTS_PER_STUDENT_TARGET = 3;  // 3 verified certs/student => 100
const WEAK_METRIC_THRESHOLD = 60;    // normalised metric below this is flagged red

// ------------------------------------------------------------ grades & GPA
/** 10-point scale on total percentage. Fail (<40%) => 0 points. */
function gradePoints(percent) {
  if (percent >= 90) return 10;
  if (percent >= 80) return 9;
  if (percent >= 70) return 8;
  if (percent >= 60) return 7;
  if (percent >= 50) return 6;
  if (percent >= 45) return 5;
  if (percent >= 40) return 4;
  return 0;
}

/** Pass rule: total >= 40% AND external >= 40% of external max. */
function isPass({ internalObtained, internalMax, externalObtained, externalMax }) {
  const total = ((internalObtained + externalObtained) / (internalMax + externalMax)) * 100;
  const ext = externalMax > 0 ? (externalObtained / externalMax) * 100 : 100;
  return total >= 40 && ext >= 40;
}

/** SGPA = Σ(credits × gradePoints) / Σ(credits), rows = [{credits, gradePoints}] */
function sgpa(rows) {
  const credits = sum(rows, (r) => r.credits);
  if (credits === 0) return 0;
  return round(sum(rows, (r) => r.credits * r.gradePoints) / credits);
}

/** CGPA over all semesters: credit-weighted. semesters = [{credits, sgpa}] */
function cgpa(semesters) {
  const credits = sum(semesters, (s) => s.credits);
  if (credits === 0) return 0;
  return round(sum(semesters, (s) => s.credits * s.sgpa) / credits);
}

/**
 * GPA predictor — SGPA needed next semester to reach a target CGPA.
 * Returns { required, feasible }. `required` can exceed 10 (=> infeasible)
 * or go below 0 (=> target already guaranteed).
 */
function requiredSgpa({ currentCgpa, creditsDone, creditsNext, targetCgpa }) {
  const required = (targetCgpa * (creditsDone + creditsNext) - currentCgpa * creditsDone) / creditsNext;
  return { required: round(required), feasible: required <= 10 };
}

// -------------------------------------------------------------- attendance
const pct = (attended, held) => (held === 0 ? 0 : round((attended / held) * 100));

/** Max extra classes that can be missed while staying >= threshold% (integer maths). */
function classesCanMiss(attended, held, threshold = 75) {
  return Math.max(0, Math.floor((attended * 100 - threshold * held) / threshold));
}

/** Consecutive classes to attend to climb back to >= threshold%. 0 if already there. */
function classesToRecover(attended, held, threshold = 75) {
  if (threshold >= 100) return Infinity;
  return Math.max(0, Math.ceil((threshold * held - 100 * attended) / (100 - threshold)));
}

/**
 * "Classes I can still miss" for a known number of REMAINING classes (e.g. the rest of the
 * semester). Returns the max absences that still end at >= threshold%, or null when even
 * attending every remaining class cannot reach the threshold.
 */
function missableInRemaining(attended, held, remaining, threshold = 75) {
  const needed = Math.ceil((threshold * (held + remaining) - 100 * attended) / 100);  // classes I must attend
  if (needed <= 0) return remaining;
  if (needed > remaining) return null;
  return remaining - needed;
}

// ------------------------------------------------------------- skill gap
/**
 * @param requirements [{skillId, requiredLevel(1-5), weight}]
 * @param owned        {skillId: level(1-5)}   (best level per skill)
 * coverage_i = min(have, required) / required   (over-qualification is not rewarded)
 * readiness  = Σ w_i·coverage_i / Σ w_i         gap = 100 − readiness
 */
function skillGap(requirements, owned) {
  const totalW = sum(requirements, (r) => r.weight);
  if (totalW === 0) return { readinessPct: 0, gapPct: 100, perSkill: [] };
  const perSkill = requirements.map((r) => {
    const have = owned[r.skillId] || 0;
    const coverage = Math.min(have, r.requiredLevel) / r.requiredLevel;
    return { skillId: r.skillId, have, required: r.requiredLevel, weight: r.weight, coveragePct: round(coverage * 100) };
  });
  const readiness = sum(perSkill, (p) => p.weight * (p.coveragePct / 100)) / totalW * 100;
  return { readinessPct: round(readiness), gapPct: round(100 - readiness), perSkill };
}

// ------------------------------------------------ component scores (0–100)
/** certs = [{category}] (verified only). Points are capped at the target. */
function certificateScore(certs) {
  const pts = sum(certs, (c) => CERT_POINTS[c.category] ?? CERT_POINTS.other);
  return round(clamp((pts / CERT_TARGET_POINTS) * 100));
}

/** participation = [{status}] */
function activityScore(participation) {
  const pts = sum(participation, (p) => ACTIVITY_POINTS[p.status] ?? 0);
  return round(clamp((pts / ACTIVITY_TARGET_POINTS) * 100));
}

/** Marks component: SGPA (or CGPA when no semester filter) on a 0–100 scale. */
const marksScore = (gpa) => round(clamp((gpa / 10) * 100));

// ---------------------------------------------------------- leaderboard
function assertWeights(w) {
  const total = sum(Object.values(w));
  if (Math.round(total) !== 100) throw new Error(`Leaderboard weights must sum to 100 (got ${total})`);
  if (Object.values(w).some((x) => x < 0)) throw new Error('Leaderboard weights must be >= 0');
}

/**
 * components: {marks, attendance, certificates, skills, resume, activity}  each 0–100
 * (skills component = 100 − verified skill-gap %)
 */
function leaderboardScore(components, weights = DEFAULT_LEADERBOARD_WEIGHTS) {
  assertWeights(weights);
  const total = sum(Object.keys(weights), (k) => (weights[k] / 100) * clamp(components[k] ?? 0));
  return round(total);
}

/**
 * Rank students. students = [{id, name, components, cgpa, attendance}]
 * Order: total ↓, CGPA ↓, attendance ↓, name ↑. Ties share a rank (1,2,2,4).
 */
function rankStudents(students, weights = DEFAULT_LEADERBOARD_WEIGHTS) {
  const scored = students.map((s) => ({ ...s, total: leaderboardScore(s.components, weights) }));
  scored.sort((a, b) =>
    b.total - a.total || (b.cgpa ?? 0) - (a.cgpa ?? 0) ||
    (b.attendance ?? 0) - (a.attendance ?? 0) || String(a.name).localeCompare(String(b.name)));
  let prev = null;
  let rank = 0;
  return scored.map((s, i) => {
    if (!prev || s.total !== prev.total) rank = i + 1;     // equal totals share a rank
    prev = s;
    return { ...s, rank };
  });
}

// --------------------------------------------------- placement readiness
/**
 * inputs: {cgpa, skillReadinessPct, certScore, portfolioScore, resumeScore,
 *          attendancePct, activeBacklogs}
 * portfolioScore = min(100, internships×40 + projects×20 + publications×20)
 */
function placementReadiness(i) {
  const raw =
    0.30 * marksScore(i.cgpa) + 0.20 * clamp(i.skillReadinessPct) + 0.15 * clamp(i.certScore) +
    0.15 * clamp(i.portfolioScore) + 0.10 * clamp(i.resumeScore) + 0.10 * clamp(i.attendancePct);
  return round(clamp(raw - 5 * (i.activeBacklogs || 0)));
}

const portfolioScore = ({ internships = 0, projects = 0, publications = 0 }) =>
  clamp(internships * 40 + projects * 20 + publications * 20);

// -------------------------------------------------- department / college
/**
 * metrics: {avgSgpa(0-10), attendancePct, passPct, certsPerStudent,
 *           placementReadiness, skillGapPct, eventParticipationPct}
 * Returns {score, components (normalised 0–100), weak: [metric names < threshold]}.
 * The same formula is applied at college level (students pooled), so
 * college scores are comparable across the university.
 */
function departmentScore(metrics, weights = DEPARTMENT_WEIGHTS, weakBelow = WEAK_METRIC_THRESHOLD) {
  const components = {
    avgSgpa: clamp((metrics.avgSgpa / 10) * 100),
    attendance: clamp(metrics.attendancePct),
    passPct: clamp(metrics.passPct),
    certificates: clamp((metrics.certsPerStudent / CERTS_PER_STUDENT_TARGET) * 100),
    placement: clamp(metrics.placementReadiness),
    skills: clamp(100 - metrics.skillGapPct),
    events: clamp(metrics.eventParticipationPct),
  };
  const totalW = sum(Object.values(weights));
  const score = sum(Object.keys(weights), (k) => weights[k] * components[k]) / totalW;
  const weak = Object.keys(components).filter((k) => components[k] < weakBelow);
  const rounded = Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round(v)]));
  return { score: round(score), components: rounded, weak };
}

// ------------------------------------------------------- dropout risk v1
/**
 * Transparent heuristic (replaceable by an ML model later).
 * inputs: {attendancePct, sgpa, prevSgpa, backlogs, activityScore}
 */
function dropoutRisk(i) {
  const f = {
    attendance: clamp((85 - i.attendancePct) / 45, 0, 1),          // 85%+ => 0, 40% => 1
    performance: clamp((7 - i.sgpa) / 4, 0, 1),                    // SGPA 7+ => 0, 3 => 1
    trend: i.prevSgpa == null ? 0 : clamp((i.prevSgpa - i.sgpa) / 2, 0, 1),
    backlogs: clamp((i.backlogs || 0) / 4, 0, 1),
    engagement: clamp(1 - (i.activityScore ?? 0) / 100, 0, 1),
  };
  const score = round(100 * (0.35 * f.attendance + 0.30 * f.performance +
    0.15 * f.trend + 0.10 * f.backlogs + 0.10 * f.engagement));
  const band = score < 30 ? 'low' : score <= 60 ? 'medium' : 'high';
  return { score, band, factors: f };
}

module.exports = {
  DEFAULT_LEADERBOARD_WEIGHTS, CERT_POINTS, ACTIVITY_POINTS, DEPARTMENT_WEIGHTS,
  clamp, round, gradePoints, isPass, sgpa, cgpa, requiredSgpa,
  pct, classesCanMiss, classesToRecover, missableInRemaining, skillGap,
  certificateScore, activityScore, marksScore, portfolioScore,
  leaderboardScore, rankStudents, placementReadiness, departmentScore, dropoutRisk,
};
