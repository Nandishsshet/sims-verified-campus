'use strict';
/**
 * College admin: overview tree, leaderboards, department analytics, alerts, insights, exports, audit.
 * Mounted at /college (after the core routes). Everything is VERIFIED-only and scoped to req.scope.collegeId,
 * so another college's ids simply do not exist here (404).
 */
const { z } = require('zod');
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { asyncHandler, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { requireActiveCollege } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const csv = require('../../utils/csv');
const ins = require('./college.insights');

router.use(requireActiveCollege);

const uuid = z.string().uuid();
const semesterQ = z.coerce.number().int().min(1).max(12).optional();

/** Everything the analytics endpoints derive from one load. */
async function snapshot(collegeId, opts) {
  const [view, pending, depts] = await Promise.all([
    ins.loadCollegeView(pool, collegeId, opts),
    ins.pendingByClass(pool, collegeId),
    pool.query('SELECT id, name, code, hod_name FROM departments WHERE college_id = $1 ORDER BY name', [collegeId]),
  ]);
  const byClass = (id) => view.students.filter((s) => s.classId === id);
  const classes = view.classes.map((c) => {
    const p = pending.get(c.id) || { total: 0, stale: 0, oldestDays: null };
    return { ...c, summary: ins.summarise(byClass(c.id)), pending: p };
  });
  const departments = depts.rows.map((d) => {
    const cls = classes.filter((c) => c.departmentId === d.id);
    return {
      id: d.id, name: d.name, code: d.code, hodName: d.hod_name, classes: cls,
      summary: ins.summarise(view.students.filter((s) => s.departmentId === d.id)),
      pending: { total: cls.reduce((a, c) => a + c.pending.total, 0), stale: cls.reduce((a, c) => a + c.pending.stale, 0) },
    };
  });
  const college = ins.summarise(view.students);
  const alerts = classes.filter((c) => c.status === 'active').map((c) => {
    const reasons = ins.classAlert({ summary: c.summary, pendingStale: c.pending.stale, pendingTotal: c.pending.total });
    return reasons.length ? { id: c.id, name: c.name, department: c.deptName, instructor: c.instructorName, severity: ins.alertSeverity(reasons, c.summary), reasons, students: c.summary.students, attendancePct: c.summary.metrics?.attendancePct ?? null, pending: c.pending } : null;
  }).filter(Boolean).sort((a, b) => (a.severity === b.severity ? b.reasons.length - a.reasons.length : a.severity === 'critical' ? -1 : 1));
  return { view, classes, departments, college, alerts };
}

const groupRow = (g, extra = {}) => ({ id: g.id, name: g.name, score: g.summary.score, components: g.summary.components, weak: g.summary.weak, students: g.summary.students, hasData: g.summary.hasData, metrics: g.summary.metrics, risk: g.summary.risk, ...extra });

// ================================================================ overview
// GET /college/overview — KPIs + the department → class → instructor tree
router.get('/overview', asyncHandler(async (req, res) => {
  const collegeId = req.scope.collegeId;
  const [snap, inst, col] = await Promise.all([
    snapshot(collegeId),
    pool.query(`SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved, count(*) FILTER (WHERE status = 'pending')::int AS pending FROM college_instructors WHERE college_id = $1`, [collegeId]),
    pool.query('SELECT name, status FROM colleges WHERE id = $1', [collegeId]),
  ]);
  const pendingTotal = snap.classes.reduce((a, c) => a + c.pending.total, 0);
  const pendingStale = snap.classes.reduce((a, c) => a + c.pending.stale, 0);
  res.json({
    college: { id: collegeId, name: col.rows[0].name },
    totals: { departments: snap.departments.length, classes: snap.classes.filter((c) => c.status === 'active').length, instructors: inst.rows[0].approved, pendingInstructors: inst.rows[0].pending, students: snap.college.students, pendingVerifications: pendingTotal, staleVerifications: pendingStale },
    score: { value: snap.college.score, components: snap.college.components, weak: snap.college.weak, metrics: snap.college.metrics, coverage: snap.college.coverage },
    risk: snap.college.risk,
    alertCount: snap.alerts.length,
    weights: { values: snap.view.weights, source: snap.view.source },
    departments: ins.rankGroups(snap.departments.map((d) => ({ ...d, score: d.summary.score }))).map((d) => ({
      id: d.id, name: d.name, code: d.code, hodName: d.hodName, rank: d.rank, score: d.summary.score, students: d.summary.students, pending: d.pending,
      classes: d.classes.map((c) => ({ id: c.id, name: c.name, status: c.status, semester: c.currentSemester, instructor: c.instructorName, students: c.summary.students, score: c.summary.score, pending: c.pending.total })),
    })),
    topStudents: snap.view.students.slice(0, 5).map((s) => ({ id: s.id, name: s.name, rank: s.rank, score: s.total, class: snap.view.classes.find((c) => c.id === s.classId)?.name })),
  });
}));

// ================================================================ leaderboards
// GET /college/leaderboard/students?departmentId&classId&semester&q&limit&offset
router.get('/leaderboard/students', validate({ query: z.object({ departmentId: uuid.optional(), classId: uuid.optional(), semester: semesterQ, q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const view = await ins.loadCollegeView(pool, req.scope.collegeId, { semester: q.semester ?? null });
  const classOf = new Map(view.classes.map((c) => [c.id, c]));
  if (q.classId && !classOf.has(q.classId)) throw notFound('Class');
  if (q.departmentId && !view.classes.some((c) => c.departmentId === q.departmentId) && !(await pool.query('SELECT 1 FROM departments WHERE id = $1 AND college_id = $2', [q.departmentId, req.scope.collegeId])).rows[0]) throw notFound('Department');
  const needle = q.q?.toLowerCase();
  const rows = view.students.filter((s) => (!q.classId || s.classId === q.classId) && (!q.departmentId || s.departmentId === q.departmentId)
    && (!needle || s.name.toLowerCase().includes(needle) || (s.rollNumber || '').toLowerCase().includes(needle)));
  res.json({
    semester: q.semester ?? null, weights: view.weights, weightsSource: view.source, total: rows.length,
    board: rows.slice(q.offset, q.offset + q.limit).map((s) => ({
      rank: s.rank, id: s.id, name: s.name, rollNumber: s.rollNumber, score: s.total, components: s.components, cgpa: s.m.cgpa, attendancePct: s.m.held ? s.m.attendancePct : null,
      class: { id: s.classId, name: classOf.get(s.classId)?.name }, department: classOf.get(s.classId)?.deptName,
    })),
  });
}));

// GET /college/leaderboard/departments  and  /classes — same formula as the college score, grouped
router.get('/leaderboard/departments', asyncHandler(async (req, res) => {
  const snap = await snapshot(req.scope.collegeId);
  res.json({ college: { score: snap.college.score }, board: ins.rankGroups(snap.departments.map((d) => groupRow(d, { code: d.code, classes: d.classes.length }))) });
}));
router.get('/leaderboard/classes', validate({ query: z.object({ departmentId: uuid.optional() }) }), asyncHandler(async (req, res) => {
  const snap = await snapshot(req.scope.collegeId);
  const rows = snap.classes.filter((c) => c.status === 'active' && (!req.query.departmentId || c.departmentId === req.query.departmentId));
  res.json({ board: ins.rankGroups(rows.map((c) => groupRow(c, { department: c.deptName, instructor: c.instructorName, semester: c.currentSemester }))) });
}));

// ================================================================ department analytics
// GET /college/analytics/departments — score, 7 components, weak flags, comparison with the college mean
router.get('/analytics/departments', asyncHandler(async (req, res) => {
  const snap = await snapshot(req.scope.collegeId);
  res.json({
    college: { score: snap.college.score, components: snap.college.components, metrics: snap.college.metrics },
    weights: scoring.DEPARTMENT_WEIGHTS,
    departments: ins.rankGroups(snap.departments.map((d) => groupRow(d, { code: d.code, classes: d.classes.length, behind: ins.behindCollege(d.summary, snap.college), coverage: d.summary.coverage }))),
  });
}));

// GET /college/analytics/departments/:id — detail: classes, SGPA trend by semester, event timeline
router.get('/analytics/departments/:id', validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const snap = await snapshot(req.scope.collegeId);
  const dep = snap.departments.find((d) => d.id === req.params.id);
  if (!dep) throw notFound('Department');
  const members = snap.view.students.filter((s) => s.departmentId === dep.id);
  const bySem = new Map();
  for (const s of members) for (const t of s.m.academics.trend) { if (!bySem.has(t.semester)) bySem.set(t.semester, []); bySem.get(t.semester).push(t.sgpa); }
  const timeline = (await pool.query(
    `SELECT to_char(date_trunc('month', a.starts_at), 'YYYY-MM') AS month, count(DISTINCT a.id)::int AS events,
            count(p.*) FILTER (WHERE p.status IN ('attended','runner_up','winner'))::int AS attended
       FROM activities a LEFT JOIN activity_participants p ON p.activity_id = a.id
      WHERE a.college_id = $1 AND a.department_id = $2 AND a.is_published AND a.starts_at > now() - interval '12 months'
      GROUP BY 1 ORDER BY 1`, [req.scope.collegeId, dep.id])).rows;
  const rank = ins.rankGroups(snap.departments.map((d) => ({ id: d.id, name: d.name, score: d.summary.score }))).find((d) => d.id === dep.id).rank;
  res.json({
    department: { id: dep.id, name: dep.name, code: dep.code, hodName: dep.hodName },
    rank, of: snap.departments.filter((d) => d.summary.score != null).length,
    summary: { ...dep.summary, behind: ins.behindCollege(dep.summary, snap.college) },
    college: { score: snap.college.score, components: snap.college.components },
    weights: scoring.DEPARTMENT_WEIGHTS,
    classes: ins.rankGroups(dep.classes.map((c) => groupRow(c, { semester: c.currentSemester, instructor: c.instructorName, status: c.status, pending: c.pending }))),
    sgpaTrend: [...bySem.entries()].sort((a, b) => a[0] - b[0]).map(([semester, v]) => ({ semester, avgSgpa: ins.avg(v), students: v.length })),
    eventTimeline: timeline,
    topStudents: members.slice(0, 5).map((s) => ({ id: s.id, name: s.name, rank: s.rank, score: s.total })),
  });
}));

// GET /college/analytics/compare?departmentIds=a,b[,c,d]
router.get('/analytics/compare', validate({ query: z.object({ departmentIds: z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(uuid).min(2).max(4)) }) }), asyncHandler(async (req, res) => {
  const snap = await snapshot(req.scope.collegeId);
  const picked = req.query.departmentIds.map((id) => snap.departments.find((d) => d.id === id));
  if (picked.some((d) => !d)) throw notFound('Department');
  res.json({ weights: scoring.DEPARTMENT_WEIGHTS, departments: picked.map((d) => groupRow(d, { code: d.code })), college: { score: snap.college.score, components: snap.college.components } });
}));

// ================================================================ alerts & insights
// GET /college/alerts — classes that need attention, with reasons
router.get('/alerts', asyncHandler(async (req, res) => {
  const snap = await snapshot(req.scope.collegeId);
  res.json({ alerts: snap.alerts, staleAfterDays: ins.STALE_DAYS });
}));

// GET /college/insights — rule-based (each line cites its numbers); `generatedBy` says so honestly
router.get('/insights', asyncHandler(async (req, res) => {
  const collegeId = req.scope.collegeId;
  const [snap, pend] = await Promise.all([snapshot(collegeId), pool.query(`SELECT count(*)::int AS n FROM college_instructors WHERE college_id = $1 AND status = 'pending'`, [collegeId])]);
  res.json({
    generatedBy: 'rules',
    insights: ins.buildInsights({
      college: snap.college, departments: snap.departments, classAlerts: snap.alerts, pendingInstructors: pend.rows[0].n,
      pending: { total: snap.classes.reduce((a, c) => a + c.pending.total, 0), stale: snap.classes.reduce((a, c) => a + c.pending.stale, 0) },
      emptyDepartments: snap.departments.filter((d) => d.classes.length === 0).map((d) => d.name),
    }),
  });
}));

// ================================================================ exports (CSV)
const EXPORTS = {
  async departments(collegeId) {
    const s = await snapshot(collegeId);
    return [['department', 'code', 'rank', 'score', 'students', 'avg_sgpa', 'attendance_pct', 'pass_pct', 'certs_per_student', 'placement_readiness', 'skill_gap_pct', 'event_participation_pct'],
      ins.rankGroups(s.departments.map((d) => ({ ...d, score: d.summary.score }))).map((d) => { const m = d.summary.metrics || {}; return [d.name, d.code, d.rank, d.summary.score, d.summary.students, m.avgSgpa, m.attendancePct, m.passPct, m.certsPerStudent, m.placementReadiness, m.skillGapPct, m.eventParticipationPct]; })];
  },
  async classes(collegeId) {
    const s = await snapshot(collegeId);
    return [['class', 'department', 'instructor', 'semester', 'students', 'score', 'attendance_pct', 'pass_pct', 'pending_verifications'],
      s.classes.map((c) => [c.name, c.deptName, c.instructorName, c.currentSemester, c.summary.students, c.summary.score, c.summary.metrics?.attendancePct, c.summary.metrics?.passPct, c.pending.total])];
  },
  async students(collegeId) {
    const v = await ins.loadCollegeView(pool, collegeId);
    const cls = new Map(v.classes.map((c) => [c.id, c]));
    return [['rank', 'roll_number', 'name', 'class', 'department', 'score', 'cgpa', 'attendance_pct', 'active_backlogs', 'risk'],
      v.students.map((s) => [s.rank, s.rollNumber, s.name, cls.get(s.classId)?.name, cls.get(s.classId)?.deptName, s.total, s.m.cgpa, s.m.held ? s.m.attendancePct : '', s.m.activeBacklogs, s.risk.band])];
  },
  async instructors(collegeId) {
    const { rows } = await pool.query(
      `SELECT u.full_name, u.email::text AS email, ci.status, d.name AS department, ci.requested_at::date::text AS requested,
              (SELECT count(*)::int FROM classes c WHERE c.instructor_id = u.id AND c.college_id = ci.college_id) AS classes
         FROM college_instructors ci JOIN users u ON u.id = ci.user_id LEFT JOIN departments d ON d.id = ci.department_id
        WHERE ci.college_id = $1 ORDER BY u.full_name`, [collegeId]);
    return [['name', 'email', 'status', 'department', 'requested', 'classes'], rows.map((r) => [r.full_name, r.email, r.status, r.department, r.requested, r.classes])];
  },
  /** NAAC / NBA-style summary: one verified-data row per department plus a college total. */
  async accreditation(collegeId) {
    const s = await snapshot(collegeId);
    const row = (name, g, classes) => { const m = g.metrics || {}; const st = g.students; return [name, classes, st, g.coverage.withMarks, m.avgSgpa, m.passPct, m.attendancePct, m.certsPerStudent, m.placementReadiness, m.eventParticipationPct, g.risk.high, g.score]; };
    return [['unit', 'classes', 'students', 'students_with_verified_marks', 'avg_sgpa', 'pass_pct', 'attendance_pct', 'certs_per_student', 'placement_readiness', 'event_participation_pct', 'high_dropout_risk', 'score'],
      [...s.departments.map((d) => row(d.name, d.summary, d.classes.length)), row('COLLEGE TOTAL', s.college, s.classes.filter((c) => c.status === 'active').length)]];
  },
};

// GET /college/export/:kind  → text/csv  (departments | classes | students | instructors | accreditation)
router.get('/export/:kind', validate({ params: z.object({ kind: z.enum(Object.keys(EXPORTS)) }) }), asyncHandler(async (req, res) => {
  const [headers, rows] = await EXPORTS[req.params.kind](req.scope.collegeId);
  await audit(pool, { ...ctxOf(req), action: 'report.export', entityType: 'college', entityId: req.scope.collegeId, metadata: { kind: req.params.kind, rows: rows.length } });
  res.type('text/csv').set('Content-Disposition', `attachment; filename="college-${req.params.kind}.csv"`).send(csv.toCsv(headers, rows));
}));

// ================================================================ audit log
// GET /college/audit-logs?limit&before&action — everything in this college (college admin, instructors, students' decisions)
router.get('/audit-logs', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().positive().optional(), action: z.string().trim().max(40).optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const like = q.action ? `${q.action.replace(/[%_\\]/g, '\\$&')}%` : null;
  const { rows } = await pool.query(
    `SELECT l.id, l.action, l.entity_type, l.actor_role, l.metadata, l.created_at, u.full_name AS actor, c.name AS class
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id LEFT JOIN classes c ON c.id = l.class_id
      WHERE l.college_id = $1 AND ($2::bigint IS NULL OR l.id < $2) AND ($3::text IS NULL OR l.action LIKE $3) ORDER BY l.id DESC LIMIT $4`,
    [req.scope.collegeId, q.before ?? null, like, q.limit + 1]);
  const page = rows.slice(0, q.limit);
  res.json({
    logs: page.map((r) => ({ id: Number(r.id), action: r.action, entityType: r.entity_type, actor: r.actor, actorRole: r.actor_role, class: r.class, metadata: r.metadata, at: r.created_at })),
    nextBefore: rows.length > q.limit ? Number(page[page.length - 1].id) : null,
  });
}));

module.exports = router;
