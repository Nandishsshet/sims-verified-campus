'use strict';
/**
 * Student dashboard summary + the "extras": placement readiness, leaderboard, goals & study
 * planner, timetable, assignments, announcements, department activities, badges,
 * suggestions and the verification-status overview.
 * Mounted at /student (paths are explicit, so no router-level guard is applied here).
 */
const { z } = require('zod');
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const { studentOnly, approvedStudentOnly, idParam } = require('./student.common');
const { loadMetrics } = require('./metrics.service');
const { computeClassLeaderboard } = require('../leaderboard/leaderboard.service');
const { buildSummary, awardBadges } = require('./summary.service');

// ----------------------------------------------------------------------------- dashboard
router.get('/dashboard', ...studentOnly, asyncHandler(async (req, res) => {
  if (!req.scope.classId) {
    const pending = req.scope.pendingClassId
      ? (await pool.query('SELECT id, name FROM classes WHERE id = $1', [req.scope.pendingClassId])).rows[0] : null;
    return res.json({ state: pending ? 'pending' : 'no_class', pendingClass: pending });
  }
  const s = await buildSummary(req.user.id, req.scope.classId);
  await awardBadges(req.user.id, s.badgeCodes);
  const [assign, acts, unread, role, badgeCount, cls] = await Promise.all([
    pool.query(
      `SELECT a.id, a.title, a.due_at, sub.submitted_at FROM assignments a
         LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = $2
        WHERE a.class_id = $1 AND sub.submitted_at IS NULL AND a.due_at > now() - interval '1 day' ORDER BY a.due_at LIMIT 3`, [req.scope.classId, req.user.id]),
    pool.query(`SELECT id, title, type, starts_at FROM activities WHERE class_id = $1 AND is_published AND starts_at > now() ORDER BY starts_at LIMIT 3`, [req.scope.classId]),
    pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.id]),
    s.m.targetRoleId ? pool.query('SELECT name FROM career_roles WHERE id = $1', [s.m.targetRoleId]) : { rows: [] },
    pool.query('SELECT (SELECT count(*)::int FROM student_badges WHERE student_id = $1) AS earned, (SELECT count(*)::int FROM badges) AS total', [req.user.id]),
    pool.query('SELECT name, current_semester FROM classes WHERE id = $1', [req.scope.classId]),
  ]);
  const m = s.m;
  res.json({
    state: 'approved',
    class: { id: req.scope.classId, name: cls.rows[0].name, currentSemester: cls.rows[0].current_semester },
    verification: s.counts,
    attendance: { ...s.overall, lowSubjects: s.subjects.filter((x) => x.alert).map((x) => ({ code: x.code, name: x.name, percentage: x.percentage })) },
    academics: { cgpa: m.cgpa, latestSgpa: m.academics.trend.at(-1)?.sgpa ?? null, backlogs: m.activeBacklogs, semesters: m.semesterCount, trend: m.academics.trend },
    certificates: { verified: m.certCount },
    portfolio: m.portfolio,
    skillGap: m.hasTargetRole ? { role: role.rows[0]?.name, gapPct: s.gap?.gapPct ?? null, verifiedGapPct: m.verifiedGapPct } : null,
    resumeScore: m.resumeScore,
    placementReadiness: s.placement,
    rank: s.me ? { rank: s.me.rank, of: s.lb.ranked.length, score: s.me.total } : null,
    unreadNotifications: unread.rows[0].n,
    upcoming: { assignments: assign.rows, activities: acts.rows },
    suggestions: s.suggestions.slice(0, 3),
    badges: badgeCount.rows[0],
  });
}));

router.get('/suggestions', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  res.json({ suggestions: (await buildSummary(req.user.id, req.scope.classId)).suggestions });
}));

// ----------------------------------------------------------------------------- placement readiness
router.get('/placement-readiness', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  const s = await buildSummary(req.user.id, req.scope.classId);
  const m = s.m;
  const parts = [
    { key: 'marks', label: 'Academic performance (CGPA)', weight: 30, value: scoring.marksScore(m.cgpa) },
    { key: 'skills', label: 'Verified skill readiness', weight: 20, value: m.skillReadinessPct },
    { key: 'certificates', label: 'Verified certificates', weight: 15, value: m.certScore },
    { key: 'portfolio', label: 'Projects, internships & publications', weight: 15, value: m.portfolioScore },
    { key: 'resume', label: 'Resume (ATS score)', weight: 10, value: m.resumeScore ?? 0 },
    { key: 'attendance', label: 'Attendance', weight: 10, value: m.attendancePct },
  ].map((p) => ({ ...p, value: scoring.round(p.value), contribution: scoring.round((p.weight * Math.min(100, p.value)) / 100) }));
  res.json({ score: s.placement, breakdown: parts, backlogPenalty: 5 * m.activeBacklogs, activeBacklogs: m.activeBacklogs });
}));

// ----------------------------------------------------------------------------- leaderboard
router.get('/leaderboard', ...approvedStudentOnly, validate({ query: z.object({ semester: z.coerce.number().int().min(1).max(12).optional() }) }), asyncHandler(async (req, res) => {
  const lb = await computeClassLeaderboard(pool, req.scope.classId, { semester: req.query.semester ?? null });
  const me = lb.ranked.find((r) => r.id === req.user.id);
  res.json({
    semester: req.query.semester ?? null, classSize: lb.ranked.length, weights: lb.weights,
    me: me ? { rank: me.rank, total: me.total, components: me.components } : null,
    // other students: name + score only — never their marks, attendance or certificates
    board: lb.ranked.map((r) => ({ rank: r.rank, name: r.name, total: r.total, isMe: r.id === req.user.id })),
  });
}));

// ----------------------------------------------------------------------------- badges
router.get('/badges', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  const s = await buildSummary(req.user.id, req.scope.classId);
  await awardBadges(req.user.id, s.badgeCodes);
  const { rows } = await pool.query(
    `SELECT b.code, b.name, b.description, b.icon, sb.awarded_at FROM badges b
       LEFT JOIN student_badges sb ON sb.badge_id = b.id AND sb.student_id = $1 ORDER BY (sb.awarded_at IS NULL), b.name`, [req.user.id]);
  res.json({ badges: rows.map((b) => ({ code: b.code, name: b.name, description: b.description, icon: b.icon, earned: Boolean(b.awarded_at), awardedAt: b.awarded_at })) });
}));

// ----------------------------------------------------------------------------- goals & study plan
const goalBody = z.object({
  type: z.enum(['cgpa', 'skill', 'certificate', 'attendance', 'custom']),
  title: z.string().trim().min(2).max(160),
  targetValue: z.number().min(0).max(1000).nullable().optional(),
  deadline: z.coerce.date().nullable().optional(),
});

router.get('/goals', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  const [{ rows }, metrics] = await Promise.all([
    pool.query('SELECT * FROM student_goals WHERE student_id = $1 ORDER BY is_done, deadline NULLS LAST, created_at DESC', [req.user.id]),
    loadMetrics(pool, [req.user.id]),
  ]);
  const m = metrics.get(req.user.id);
  // goals tied to a measurable metric track it automatically (from VERIFIED data)
  const live = { cgpa: m.cgpa, attendance: m.attendancePct, certificate: m.certCount, skill: scoring.round(100 - m.verifiedGapPct) };
  res.json({ goals: rows.map((g) => {
    const cur = g.type in live ? live[g.type] : g.current_value == null ? null : Number(g.current_value);
    const target = g.target_value == null ? null : Number(g.target_value);
    return { id: g.id, type: g.type, title: g.title, targetValue: target, currentValue: cur, deadline: g.deadline, isDone: g.is_done || (target != null && cur != null && cur >= target),
      progressPct: target && cur != null ? Math.min(100, Math.round((cur / target) * 100)) : null };
  }) });
}));

router.post('/goals', ...approvedStudentOnly, validate({ body: goalBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await pool.query(
    `INSERT INTO student_goals (student_id, type, title, target_value, deadline) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.user.id, b.type, b.title, b.targetValue ?? null, b.deadline?.toISOString().slice(0, 10) ?? null]);
  res.status(201).json({ id: rows[0].id });
}));

router.patch('/goals/:id', ...approvedStudentOnly, validate({ params: idParam, body: goalBody.partial().extend({ isDone: z.boolean().optional(), currentValue: z.number().min(0).max(1000).optional() }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rowCount } = await pool.query(
    `UPDATE student_goals SET title = COALESCE($3, title), target_value = COALESCE($4, target_value), deadline = COALESCE($5, deadline),
            is_done = COALESCE($6, is_done), current_value = COALESCE($7, current_value) WHERE id = $1 AND student_id = $2`,
    [req.params.id, req.user.id, b.title ?? null, b.targetValue ?? null, b.deadline?.toISOString().slice(0, 10) ?? null, b.isDone ?? null, b.currentValue ?? null]);
  if (!rowCount) throw notFound('Goal');
  res.json({ ok: true });
}));

router.delete('/goals/:id', ...approvedStudentOnly, validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM student_goals WHERE id = $1 AND student_id = $2', [req.params.id, req.user.id]);
  if (!rowCount) throw notFound('Goal');
  res.status(204).end();
}));

const planBody = z.object({ title: z.string().trim().min(2).max(160), plannedDate: z.coerce.date(), durationMin: z.number().int().min(5).max(600).default(60), goalId: z.string().uuid().nullable().optional() });

router.get('/study-plan', ...approvedStudentOnly, validate({ query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, goal_id, title, planned_date::text AS planned_date, duration_min, is_done FROM study_plan_items
      WHERE student_id = $1 AND ($2::date IS NULL OR planned_date >= $2::date) AND ($3::date IS NULL OR planned_date <= $3::date)
      ORDER BY planned_date, id`, [req.user.id, req.query.from?.toISOString().slice(0, 10) ?? null, req.query.to?.toISOString().slice(0, 10) ?? null]);
  res.json({ items: rows.map((r) => ({ id: r.id, goalId: r.goal_id, title: r.title, plannedDate: r.planned_date, durationMin: r.duration_min, isDone: r.is_done })) });
}));

router.post('/study-plan', ...approvedStudentOnly, validate({ body: planBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  if (b.goalId) {
    const g = await pool.query('SELECT 1 FROM student_goals WHERE id = $1 AND student_id = $2', [b.goalId, req.user.id]);
    if (!g.rowCount) throw badRequest('INVALID_GOAL', 'Unknown goal');
  }
  const { rows } = await pool.query(
    'INSERT INTO study_plan_items (student_id, goal_id, title, planned_date, duration_min) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [req.user.id, b.goalId ?? null, b.title, b.plannedDate.toISOString().slice(0, 10), b.durationMin]);
  res.status(201).json({ id: rows[0].id });
}));

router.patch('/study-plan/:id', ...approvedStudentOnly, validate({ params: idParam, body: z.object({ isDone: z.boolean() }) }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE study_plan_items SET is_done = $3 WHERE id = $1 AND student_id = $2', [req.params.id, req.user.id, req.body.isDone]);
  if (!rowCount) throw notFound('Plan item');
  res.json({ ok: true });
}));

router.delete('/study-plan/:id', ...approvedStudentOnly, validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM study_plan_items WHERE id = $1 AND student_id = $2', [req.params.id, req.user.id]);
  if (!rowCount) throw notFound('Plan item');
  res.status(204).end();
}));

// ----------------------------------------------------------------------------- class life (read-mostly)
router.get('/timetable', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.day_of_week, to_char(t.starts_at, 'HH24:MI') AS starts, to_char(t.ends_at, 'HH24:MI') AS ends, t.room, s.name, s.code
       FROM timetable_entries t JOIN subjects s ON s.id = t.subject_id WHERE t.class_id = $1 ORDER BY t.day_of_week, t.starts_at`, [req.scope.classId]);
  res.json({ entries: rows.map((r) => ({ id: r.id, day: r.day_of_week, starts: r.starts, ends: r.ends, room: r.room, subject: r.name, code: r.code })) });
}));

router.get('/assignments', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.description, a.due_at, s.name AS subject, sub.submitted_at FROM assignments a
       LEFT JOIN subjects s ON s.id = a.subject_id
       LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = $2
      WHERE a.class_id = $1 ORDER BY a.due_at DESC LIMIT 100`, [req.scope.classId, req.user.id]);
  const now = Date.now();
  res.json({ assignments: rows.map((r) => ({ id: r.id, title: r.title, description: r.description, subject: r.subject, dueAt: r.due_at, submittedAt: r.submitted_at,
    status: r.submitted_at ? 'submitted' : new Date(r.due_at).getTime() < now ? 'overdue' : 'due' })) });
}));

router.post('/assignments/:id/submit', ...approvedStudentOnly, validate({ params: idParam }), asyncHandler(async (req, res) => {
  const a = await pool.query('SELECT 1 FROM assignments WHERE id = $1 AND class_id = $2', [req.params.id, req.scope.classId]);
  if (!a.rowCount) throw notFound('Assignment');
  await pool.query(
    `INSERT INTO assignment_submissions (assignment_id, student_id, submitted_at) VALUES ($1,$2, now())
     ON CONFLICT (assignment_id, student_id) DO UPDATE SET submitted_at = COALESCE(assignment_submissions.submitted_at, now())`, [req.params.id, req.user.id]);
  res.json({ submitted: true });
}));

router.get('/announcements', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.scope, a.title, a.body, a.is_pinned, a.created_at, u.full_name AS author
       FROM announcements a JOIN users u ON u.id = a.author_id
      WHERE a.class_id = $1 OR a.college_id = $2 OR a.university_id = $3
      ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT 50`, [req.scope.classId, req.scope.collegeId, req.scope.universityId]);
  res.json({ announcements: rows.map((r) => ({ id: r.id, scope: r.scope, title: r.title, body: r.body, pinned: r.is_pinned, createdAt: r.created_at, author: r.author })) });
}));

router.get('/activities', ...approvedStudentOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.type, a.title, a.description, a.venue, a.starts_at, a.ends_at, p.status AS my_status FROM activities a
       LEFT JOIN activity_participants p ON p.activity_id = a.id AND p.student_id = $2
      WHERE a.class_id = $1 AND a.is_published ORDER BY a.starts_at DESC LIMIT 100`, [req.scope.classId, req.user.id]);
  const now = Date.now();
  res.json({ activities: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, description: r.description, venue: r.venue, startsAt: r.starts_at, endsAt: r.ends_at,
    myStatus: r.my_status, open: new Date(r.ends_at || new Date(r.starts_at).getTime() + 86400000).getTime() > now })) });
}));

router.post('/activities/:id/register', ...approvedStudentOnly, validate({ params: idParam }), asyncHandler(async (req, res) => {
  const a = (await pool.query(
    `SELECT id, COALESCE(ends_at, starts_at + interval '1 day') > now() AS open FROM activities WHERE id = $1 AND class_id = $2 AND is_published`, [req.params.id, req.scope.classId])).rows[0];
  if (!a) throw notFound('Activity');
  if (!a.open) throw new AppError(409, 'ACTIVITY_CLOSED', 'This activity has already ended');
  await pool.query(`INSERT INTO activity_participants (activity_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.id, req.user.id]);
  res.status(201).json({ registered: true });
}));

// ----------------------------------------------------------------------------- verification overview
router.get('/verification-status', ...studentOnly, asyncHandler(async (req, res) => {
  const id = req.user.id;
  const [prof, certs, items, marks, att] = await Promise.all([
    pool.query('SELECT verification_status, verifier_remarks, verified_at, updated_at FROM student_profiles WHERE user_id = $1', [id]),
    pool.query('SELECT id, title, verification_status, verifier_remarks, verified_at, updated_at FROM certificates WHERE student_id = $1', [id]),
    pool.query('SELECT id, title, type, verification_status, verifier_remarks, verified_at, updated_at FROM portfolio_items WHERE student_id = $1', [id]),
    pool.query(`SELECT m.id, s.name, m.verification_status, m.verifier_remarks, m.verified_at, m.updated_at FROM marks m JOIN subjects s ON s.id = m.subject_id WHERE m.student_id = $1 AND m.source = 'student'`, [id]),
    pool.query(`SELECT a.id, a.attendance_date::text AS d, s.name, a.verification_status, a.verifier_remarks, a.verified_at, a.created_at AS updated_at FROM attendance_records a JOIN subjects s ON s.id = a.subject_id WHERE a.student_id = $1 AND a.source = 'student'`, [id]),
  ]);
  const item = (type, r, label, link) => ({ type, id: r.id ?? id, label, status: r.verification_status, remarks: r.verifier_remarks, verifiedAt: r.verified_at, updatedAt: r.updated_at, link });
  const list = [
    ...prof.rows.map((r) => item('profile', r, 'Personal profile', '/student/profile')),
    ...certs.rows.map((r) => item('certificate', r, r.title, '/student/certificates')),
    ...items.rows.map((r) => item(r.type, r, r.title, '/student/portfolio')),
    ...marks.rows.map((r) => item('marks', r, `Marks claim — ${r.name}`, '/student/academics')),
    ...att.rows.map((r) => item('attendance', r, `Attendance claim — ${r.name} (${r.d})`, '/student/attendance')),
  ];
  const rank = { rejected: 0, correction_requested: 0, pending: 1, verified: 2 };
  list.sort((a, b) => rank[a.status] - rank[b.status] || new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ items: list });
}));

module.exports = router;
