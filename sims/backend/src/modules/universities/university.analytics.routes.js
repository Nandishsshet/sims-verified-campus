'use strict';
/**
 * University head: overview, college leaderboard, cross-college analytics (filters, heat-map, year-over-year),
 * best departments, top students, alerts, insights, exports, audit log.
 * Mounted at /university (after the approval routes). Everything is VERIFIED-only and scoped to req.scope.universityId,
 * so another university's ids simply do not exist here (404). Students are shown by name, college and score only.
 */
const { z } = require('zod');
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { asyncHandler, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const csv = require('../../utils/csv');
const keys = require('../keys/keys.service');
const { summarise, rankGroups, behindCollege, classAlert, alertSeverity, STALE_DAYS } = require('../colleges/college.insights');
const uni = require('./university.insights');

const uuid = z.string().uuid();
const METRIC_KEYS = ['avgSgpa', 'attendance', 'passPct', 'certificates', 'placement', 'skills', 'events'];

/** One load → one roll-up. `filter` narrows the student pool (analytics filters). */
async function snapshot(universityId, { semester = null, filter = {} } = {}) {
  const [view, pending] = await Promise.all([uni.loadUniversityView(pool, universityId, { semester }), uni.pendingByCollege(pool, universityId)]);
  const r = uni.rollUp(view, pending, filter);
  const active = r.colleges.filter((c) => c.status === 'active');
  const alerts = active.map((c) => {
    const reasons = classAlert({ summary: c.summary, pendingStale: c.pending.stale, pendingTotal: c.pending.total });
    return reasons.length ? { id: c.id, name: c.name, severity: alertSeverity(reasons, c.summary), reasons, students: c.summary.students, attendancePct: c.summary.metrics?.attendancePct ?? null, pending: c.pending } : null;
  }).filter(Boolean).sort((a, b) => (a.severity === b.severity ? b.reasons.length - a.reasons.length : a.severity === 'critical' ? -1 : 1));
  return { view, ...r, active, alerts };
}

const groupRow = (g, extra = {}) => ({ id: g.id, name: g.name, score: g.summary.score, components: g.summary.components, weak: g.summary.weak, students: g.summary.students, hasData: g.summary.hasData, metrics: g.summary.metrics, risk: g.summary.risk, ...extra });
const collegeRows = (s) => rankGroups(s.active.map((c) => groupRow(c, { departments: c.departments, classes: c.classes, pending: c.pending, behind: behindCollege(c.summary, s.university) })));

// ================================================================ overview
router.get('/overview', asyncHandler(async (req, res) => {
  const uid = req.scope.universityId;
  const [s, counts, pendingColleges] = await Promise.all([
    snapshot(uid),
    pool.query(
      `SELECT (SELECT count(*)::int FROM college_instructors ci JOIN colleges c ON c.id = ci.college_id WHERE c.university_id = $1 AND ci.status = 'approved') AS instructors,
              (SELECT count(*)::int FROM college_instructors ci JOIN colleges c ON c.id = ci.college_id WHERE c.university_id = $1 AND ci.status = 'pending') AS pending_instructors,
              (SELECT count(*)::int FROM departments d JOIN colleges c ON c.id = d.college_id WHERE c.university_id = $1) AS departments`, [uid]),
    pool.query(
      `SELECT col.id, col.name, col.created_at, u.full_name AS admin_name FROM colleges col JOIN users u ON u.id = col.admin_user_id
        WHERE col.university_id = $1 AND col.status = 'pending' ORDER BY col.created_at`, [uid]),
  ]);
  const by = (st) => s.colleges.filter((c) => c.status === st).length;
  const rows = collegeRows(s);
  const top = s.view.students.filter((x) => x.m.held > 0 || x.m.semesterCount > 0).slice(0, 5);
  const nameOf = new Map(s.colleges.map((c) => [c.id, c.name]));
  res.json({
    university: { id: uid, name: (await pool.query('SELECT name FROM universities WHERE id = $1', [uid])).rows[0]?.name },
    totals: {
      colleges: { total: s.colleges.length, active: by('active'), pending: by('pending'), suspended: by('suspended') },
      departments: counts.rows[0].departments, classes: s.active.reduce((a, c) => a + c.classes, 0), instructors: counts.rows[0].instructors, pendingInstructors: counts.rows[0].pending_instructors,
      students: s.university.students,
      pendingVerifications: s.active.reduce((a, c) => a + c.pending.total, 0), staleVerifications: s.active.reduce((a, c) => a + c.pending.stale, 0),
    },
    score: { value: s.university.score, components: s.university.components, weak: s.university.weak, metrics: s.university.metrics, coverage: s.university.coverage },
    risk: s.university.risk, alertCount: s.alerts.length,
    colleges: rows.map((c) => ({ id: c.id, name: c.name, status: 'active', rank: c.rank, score: c.score, students: c.students, departments: c.departments, classes: c.classes, weak: c.weak, pending: c.pending, alerts: s.alerts.find((a) => a.id === c.id)?.severity ?? null })),
    inactiveColleges: s.colleges.filter((c) => c.status !== 'active').map((c) => ({ id: c.id, name: c.name, status: c.status })),
    pendingColleges: pendingColleges.rows.map((c) => ({ id: c.id, name: c.name, adminName: c.admin_name, requestedAt: c.created_at })),
    topStudents: top.map((x) => ({ rank: x.rank, name: x.name, college: nameOf.get(x.collegeId), score: x.total })),
  });
}));

// ================================================================ college detail (drill-down)
// GET /university/colleges/:id — profile + roll-up of one college (works for pending / suspended colleges: they simply have no data)
router.get('/colleges/:id', validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const uid = req.scope.universityId;
  const c = (await pool.query(
    `SELECT col.id, col.name, col.status, col.address, col.affiliation, col.principal_name, col.contact_email, col.contact_phone, col.approved_at, col.created_at,
            u.full_name AS admin_name, u.email::text AS admin_email,
            (SELECT count(*)::int FROM college_instructors ci WHERE ci.college_id = col.id AND ci.status = 'approved') AS instructors,
            (SELECT count(*)::int FROM college_instructors ci WHERE ci.college_id = col.id AND ci.status = 'pending') AS pending_instructors
       FROM colleges col JOIN users u ON u.id = col.admin_user_id WHERE col.id = $1 AND col.university_id = $2`, [req.params.id, uid])).rows[0];
  if (!c) throw notFound('College');
  const s = await snapshot(uid);
  const me = s.colleges.find((x) => x.id === c.id);
  const ranked = collegeRows(s);
  const mine = ranked.find((x) => x.id === c.id);
  const sub = uni.rollUp(s.view, new Map(), { collegeId: c.id });
  const key = c.status === 'active' ? keys.publicKey(await keys.getActiveKey(pool, 'college', c.id)) : null;
  res.json({
    college: { id: c.id, name: c.name, status: c.status, address: c.address, affiliation: c.affiliation, principalName: c.principal_name, contactEmail: c.contact_email, contactPhone: c.contact_phone, approvedAt: c.approved_at, createdAt: c.created_at, admin: { name: c.admin_name, email: c.admin_email }, instructors: c.instructors, pendingInstructors: c.pending_instructors },
    rank: mine?.rank ?? null, of: ranked.filter((x) => x.rank != null).length,
    summary: { ...me.summary, behind: behindCollege(me.summary, s.university) },
    university: { score: s.university.score, components: s.university.components },
    pending: me.pending,
    departments: rankGroups(sub.departments.filter((d) => d.collegeId === c.id).map((d) => groupRow(d, { code: d.code }))),
    sgpaTrend: uni.sgpaTrend(sub.pool), cohorts: sub.cohorts.map((y) => ({ year: y.year, students: y.summary.students, score: y.summary.score })),
    alerts: s.alerts.find((a) => a.id === c.id) ?? null,
    key,
  });
}));

// ================================================================ leaderboards
// GET /university/leaderboard/colleges — ranked by the aggregated college score (the same formula as everywhere else)
router.get('/leaderboard/colleges', asyncHandler(async (req, res) => {
  const s = await snapshot(req.scope.universityId);
  res.json({ university: { score: s.university.score, components: s.university.components }, board: collegeRows(s) });
}));

// GET /university/best-departments?limit&code — departments ranked across colleges (a department is one college's CSE, ECE, …)
router.get('/best-departments', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), code: z.string().trim().toUpperCase().max(12).optional() }) }), asyncHandler(async (req, res) => {
  const s = await snapshot(req.scope.universityId);
  const rows = s.departments.filter((d) => !req.query.code || d.code === req.query.code).map((d) => groupRow(d, { code: d.code, college: d.college, collegeId: d.collegeId }));
  const board = rankGroups(rows);
  res.json({ total: board.length, board: board.slice(0, req.query.limit) });
}));

// GET /university/top-students?limit&collegeId — name, college, department and score ONLY (no roll number, e-mail or id)
router.get('/top-students', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(10), collegeId: uuid.optional() }) }), asyncHandler(async (req, res) => {
  const view = await uni.loadUniversityView(pool, req.scope.universityId);
  if (req.query.collegeId && !view.colleges.some((c) => c.id === req.query.collegeId)) throw notFound('College');
  const name = new Map(view.colleges.map((c) => [c.id, c.name])); const dept = new Map(view.departments.map((d) => [d.id, d.name]));
  const pool_ = view.students.filter((x) => (x.m.held > 0 || x.m.semesterCount > 0) && (!req.query.collegeId || x.collegeId === req.query.collegeId));
  // ranks are university-wide (competition ranking), even when the list is filtered to one college
  res.json({ total: pool_.length, weights: scoring.DEFAULT_LEADERBOARD_WEIGHTS, board: pool_.slice(0, req.query.limit).map((x) => ({ rank: x.rank, name: x.name, college: name.get(x.collegeId), department: dept.get(x.departmentId), score: x.total })) });
}));

// ================================================================ analytics
// GET /university/analytics?collegeId&departmentCode&admissionYear&semester
router.get('/analytics', validate({ query: z.object({
  collegeId: uuid.optional(), departmentCode: z.string().trim().toUpperCase().max(12).optional(),
  admissionYear: z.coerce.number().int().min(1990).max(2100).optional(), semester: z.coerce.number().int().min(1).max(12).optional(),
}) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const all = await snapshot(req.scope.universityId);                      // unfiltered: filter options + college existence
  if (q.collegeId && !all.colleges.some((c) => c.id === q.collegeId)) throw notFound('College');
  const filter = { collegeId: q.collegeId, departmentCode: q.departmentCode, admissionYear: q.admissionYear };
  const s = Object.values(filter).some(Boolean) || q.semester ? await snapshot(req.scope.universityId, { semester: q.semester ?? null, filter }) : all;

  const codeOf = new Map(s.view.departments.map((d) => [d.id, d.code]));
  // departments with the same code (every college's "CSE") are one group here
  const byDepartment = [...new Set(s.pool.map((x) => codeOf.get(x.departmentId)))].filter(Boolean).map((code) => {
    const members = s.pool.filter((x) => codeOf.get(x.departmentId) === code);
    return groupRow({ id: code, name: code, summary: summarise(members) }, { code, colleges: new Set(members.map((x) => x.collegeId)).size });
  });
  const rankedDepartments = rankGroups(byDepartment);

  res.json({
    filters: {
      applied: { collegeId: q.collegeId ?? null, departmentCode: q.departmentCode ?? null, admissionYear: q.admissionYear ?? null, semester: q.semester ?? null },
      options: {
        colleges: all.active.map((c) => ({ id: c.id, name: c.name })),
        departmentCodes: [...new Set(all.view.departments.filter((d) => all.active.some((c) => c.id === d.collegeId)).map((d) => d.code))].sort(),
        admissionYears: all.cohorts.map((y) => y.year),
      },
    },
    summary: { students: s.university.students, hasData: s.university.hasData, score: s.university.score, metrics: s.university.metrics, components: s.university.components, weak: s.university.weak, risk: s.university.risk, coverage: s.university.coverage },
    byCollege: rankGroups(s.active.filter((c) => c.summary.students > 0).map((c) => groupRow(c))),
    byDepartment: rankedDepartments,
    byYear: s.cohorts.map((y) => ({ year: y.year, colleges: y.colleges, students: y.summary.students, score: y.summary.score, metrics: y.summary.metrics, components: y.summary.components })),
    sgpaTrend: uni.sgpaTrend(s.pool),
  });
}));

// GET /university/analytics/heatmap — college × metric matrix (0–100 components; `weak` < 60)
router.get('/analytics/heatmap', asyncHandler(async (req, res) => {
  const s = await snapshot(req.scope.universityId);
  res.json({
    metrics: METRIC_KEYS,
    university: { score: s.university.score, values: s.university.components },
    rows: rankGroups(s.active.map((c) => ({ id: c.id, name: c.name, score: c.summary.score, students: c.summary.students, values: c.summary.components, weak: c.summary.weak }))),
  });
}));

// GET /university/analytics/yoy — admission-year cohorts, overall and per college (a cohort = students admitted in that year)
router.get('/analytics/yoy', asyncHandler(async (req, res) => {
  const s = await snapshot(req.scope.universityId);
  const years = s.cohorts.map((y, i) => ({ year: y.year, students: y.summary.students, colleges: y.colleges, score: y.summary.score, metrics: y.summary.metrics, components: y.summary.components,
    delta: i > 0 && y.summary.score != null && s.cohorts[i - 1].summary.score != null ? scoring.round(y.summary.score - s.cohorts[i - 1].summary.score, 2) : null }));
  const series = s.active.map((c) => ({
    collegeId: c.id, name: c.name,
    points: s.cohorts.map((y) => { const sm = summarise(s.pool.filter((x) => x.collegeId === c.id && x.admissionYear === y.year)); return { year: y.year, students: sm.students, score: sm.score }; }),
  }));
  res.json({ years, series });
}));

// ================================================================ alerts & insights
router.get('/alerts', asyncHandler(async (req, res) => {
  const s = await snapshot(req.scope.universityId);
  res.json({ alerts: s.alerts, staleAfterDays: STALE_DAYS });
}));

router.get('/insights', asyncHandler(async (req, res) => {
  const s = await snapshot(req.scope.universityId);
  res.json({
    generatedBy: 'rules',
    insights: uni.buildUniversityInsights({
      university: s.university, colleges: s.active, collegeAlerts: s.alerts,
      pending: { total: s.active.reduce((a, c) => a + c.pending.total, 0), stale: s.active.reduce((a, c) => a + c.pending.stale, 0) },
      pendingColleges: s.colleges.filter((c) => c.status === 'pending').length, suspendedColleges: s.colleges.filter((c) => c.status === 'suspended').length,
      emptyColleges: s.active.filter((c) => c.classes === 0).map((c) => c.name),
    }),
  });
}));

// ================================================================ exports (CSV)
const m = (g) => g.metrics || {};
const EXPORTS = {
  async colleges(uid) {
    const s = await snapshot(uid);
    return [['college', 'rank', 'score', 'students', 'departments', 'classes', 'avg_sgpa', 'attendance_pct', 'pass_pct', 'certs_per_student', 'placement_readiness', 'skill_gap_pct', 'event_participation_pct', 'pending_verifications', 'stale_verifications'],
      collegeRows(s).map((c) => [c.name, c.rank, c.score, c.students, c.departments, c.classes, m(c).avgSgpa, m(c).attendancePct, m(c).passPct, m(c).certsPerStudent, m(c).placementReadiness, m(c).skillGapPct, m(c).eventParticipationPct, c.pending.total, c.pending.stale])];
  },
  async departments(uid) {
    const s = await snapshot(uid);
    const board = rankGroups(s.departments.map((d) => groupRow(d, { code: d.code, college: d.college })));
    return [['rank', 'college', 'department', 'code', 'score', 'students', 'avg_sgpa', 'attendance_pct', 'pass_pct', 'placement_readiness'],
      board.map((d) => [d.rank, d.college, d.name, d.code, d.score, d.students, m(d).avgSgpa, m(d).attendancePct, m(d).passPct, m(d).placementReadiness])];
  },
  async cohorts(uid) {
    const s = await snapshot(uid);
    return [['admission_year', 'colleges', 'students', 'score', 'avg_sgpa', 'attendance_pct', 'pass_pct', 'certs_per_student', 'placement_readiness'],
      s.cohorts.map((y) => [y.year, y.colleges, y.summary.students, y.summary.score, m(y.summary).avgSgpa, m(y.summary).attendancePct, m(y.summary).passPct, m(y.summary).certsPerStudent, m(y.summary).placementReadiness])];
  },
};

// GET /university/export/:kind → text/csv  (colleges | departments | cohorts)
router.get('/export/:kind', validate({ params: z.object({ kind: z.enum(Object.keys(EXPORTS)) }) }), asyncHandler(async (req, res) => {
  const [headers, rows] = await EXPORTS[req.params.kind](req.scope.universityId);
  await audit(pool, { ...ctxOf(req), action: 'report.export', entityType: 'university', entityId: req.scope.universityId, metadata: { kind: req.params.kind, rows: rows.length } });
  res.type('text/csv').set('Content-Disposition', `attachment; filename="university-${req.params.kind}.csv"`).send(csv.toCsv(headers, rows));
}));

// ================================================================ audit log
// GET /university/audit-logs?limit&before&action&collegeId — every audit row stamped with this university
router.get('/audit-logs', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().positive().optional(), action: z.string().trim().max(40).optional(), collegeId: uuid.optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const like = q.action ? `${q.action.replace(/[%_\\]/g, '\\$&')}%` : null;
  const { rows } = await pool.query(
    `SELECT l.id, l.action, l.entity_type, l.actor_role, l.metadata, l.created_at, u.full_name AS actor, col.name AS college
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id LEFT JOIN colleges col ON col.id = l.college_id
      WHERE l.university_id = $1 AND ($2::bigint IS NULL OR l.id < $2) AND ($3::text IS NULL OR l.action LIKE $3) AND ($4::uuid IS NULL OR l.college_id = $4)
      ORDER BY l.id DESC LIMIT $5`, [req.scope.universityId, q.before ?? null, like, q.collegeId ?? null, q.limit + 1]);
  const page = rows.slice(0, q.limit);
  res.json({
    logs: page.map((r) => ({ id: Number(r.id), action: r.action, entityType: r.entity_type, actor: r.actor, actorRole: r.actor_role, college: r.college, metadata: r.metadata, at: r.created_at })),
    nextBefore: rows.length > q.limit ? Number(page[page.length - 1].id) : null,
  });
}));

module.exports = router;
