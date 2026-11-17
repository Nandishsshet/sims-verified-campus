'use strict';
/**
 * Class analytics, student roster / detail, leaderboard (+ weights) and CSV exports.
 * Mounted at /classes/:classId. Every number is VERIFIED-only: it comes from loadClassView →
 * loadMetrics, the same code the students see on their own dashboards.
 */
const { z } = require('zod');
const router = require('express').Router({ mergeParams: true });
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const csv = require('../../utils/csv');
const { subjectBreakdown } = require('../student/attendance.service');
const { getWeights } = require('../leaderboard/leaderboard.service');
const { loadClassView, avg, bucketise, ATTENDANCE_THRESHOLD } = require('./class.insights');

const uuid = z.string().uuid();
const semesterQ = z.object({ semester: z.coerce.number().int().min(1).max(12).optional() });

// ================================================================ roster
// GET /classes/:classId/students?q=
router.get('/students', validate({ query: z.object({ q: z.string().trim().max(80).optional() }) }), asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const [view, pending, counts] = await Promise.all([
    loadClassView(pool, classId),
    pool.query(`SELECT student_id, count(*)::int AS n FROM verification_requests WHERE class_id = $1 AND status = 'pending' GROUP BY 1`, [classId]),
    pool.query(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending_joins FROM class_enrollments WHERE class_id = $1`, [classId]),
  ]);
  const pend = new Map(pending.rows.map((r) => [r.student_id, r.n]));
  const q = req.query.q?.toLowerCase();
  const students = view.students
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.rollNumber || '').toLowerCase().includes(q))
    .map((s) => ({
      id: s.id, name: s.name, rollNumber: s.rollNumber, rank: s.rank, score: s.total, cgpa: s.m.cgpa,
      attendancePct: s.m.held ? s.m.attendancePct : null, backlogs: s.m.activeBacklogs, certificates: s.m.certCount,
      projects: s.m.projectCount, placementReadiness: s.placement, risk: { band: s.risk.band, score: s.risk.score },
      pendingItems: pend.get(s.id) || 0, hasData: s.hasData,
    }));
  res.json({ students, pendingJoinRequests: counts.rows[0].pending_joins });
}));

// GET /classes/:classId/students/:sid — everything the instructor needs on one student
router.get('/students/:sid', validate({ params: z.object({ classId: uuid, sid: uuid }) }), asyncHandler(async (req, res) => {
  const { classId, sid } = req.params;
  const view = await loadClassView(pool, classId);
  const s = view.students.find((x) => x.id === sid);
  if (!s) throw notFound('Student');                                   // not an approved member of THIS class

  const [profile, enrol, attendance, certs, port, notes, pending, parents] = await Promise.all([
    pool.query(
      `SELECT u.full_name, u.email, u.phone, (u.avatar_url IS NOT NULL) AS has_photo, p.date_of_birth::text AS dob, p.gender, p.address,
              p.guardian_name, p.guardian_email, p.guardian_phone, p.summary, p.linkedin_url, p.github_url, p.verification_status
         FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id WHERE u.id = $1`, [sid]),
    pool.query('SELECT id, roll_number, requested_at, decided_at FROM class_enrollments WHERE class_id = $1 AND student_id = $2', [classId, sid]),
    subjectBreakdown(sid, classId, null, ATTENDANCE_THRESHOLD),
    pool.query('SELECT id, title, issuer, category, verification_status FROM certificates WHERE student_id = $1 ORDER BY created_at DESC', [sid]),
    pool.query('SELECT id, title, type, verification_status FROM portfolio_items WHERE student_id = $1 ORDER BY created_at DESC', [sid]),
    pool.query(
      `SELECT n.id, n.note, n.visible_to_student, n.created_at, u.full_name AS by FROM mentoring_notes n JOIN users u ON u.id = n.instructor_id
        WHERE n.class_id = $1 AND n.student_id = $2 ORDER BY n.created_at DESC LIMIT 50`, [classId, sid]),
    pool.query(`SELECT id, entity_type::text AS type FROM verification_requests WHERE class_id = $1 AND student_id = $2 AND status = 'pending'`, [classId, sid]),
    pool.query(`SELECT channel, reason, status, created_at FROM parent_notifications WHERE student_id = $1 ORDER BY created_at DESC LIMIT 10`, [sid]),
  ]);
  const p = profile.rows[0]; const m = s.m;
  res.json({
    student: {
      id: sid, name: p.full_name, email: p.email, phone: p.phone, hasPhoto: p.has_photo, rollNumber: enrol.rows[0].roll_number, joinedAt: enrol.rows[0].decided_at,
      dateOfBirth: p.dob, gender: p.gender, address: p.address, guardian: { name: p.guardian_name, email: p.guardian_email, phone: p.guardian_phone },
      summary: p.summary, linkedinUrl: p.linkedin_url, githubUrl: p.github_url, profileStatus: p.verification_status,
    },
    rank: { rank: s.rank, of: view.students.length, score: s.total, components: s.components, weights: view.weights },
    academics: {
      cgpa: m.cgpa, creditsDone: m.creditsDone, trend: m.academics.trend,
      semesters: m.academics.semesters.map((x) => ({ semester: x.semester, sgpa: x.sgpa, backlogs: x.backlogCount, subjects: x.subjects.map((y) => ({ code: y.code, name: y.name, credits: Number(y.credits), pass: y.is_pass, gradePoints: Number(y.grade_points) })) })),
      activeBacklogs: m.academics.activeBacklogs.map((b) => ({ code: b.code, name: b.name, semester: b.semester })),
    },
    attendance: { overall: { attended: m.attended, held: m.held, percentage: m.attendancePct }, subjects: attendance },
    certificates: certs.rows.map((c) => ({ id: c.id, title: c.title, issuer: c.issuer, category: c.category, status: c.verification_status })),
    portfolio: port.rows.map((c) => ({ id: c.id, title: c.title, type: c.type, status: c.verification_status })),
    skills: { hasTargetRole: m.hasTargetRole, verifiedGapPct: m.verifiedGapPct, readinessPct: m.skillReadinessPct },
    placementReadiness: s.placement, resumeScore: m.resumeScore,
    risk: s.risk, pending: pending.rows, notes: notes.rows.map((n) => ({ id: n.id, note: n.note, visibleToStudent: n.visible_to_student, createdAt: n.created_at, by: n.by })),
    parentNotifications: parents.rows.map((r) => ({ channel: r.channel, reason: r.reason, status: r.status, createdAt: r.created_at })),
  });
}));

// PATCH /classes/:classId/students/:sid — roll number (unique per class → 409 ROLL_NUMBER_TAKEN)
router.patch('/students/:sid', validate({ params: z.object({ classId: uuid, sid: uuid }), body: z.object({ rollNumber: z.string().trim().min(1).max(40) }) }), asyncHandler(async (req, res) => {
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE class_enrollments SET roll_number = $3 WHERE class_id = $1 AND student_id = $2 AND status = 'approved' RETURNING id, roll_number`,
      [req.params.classId, req.params.sid, req.body.rollNumber]);
    if (!rows[0]) throw notFound('Student');
    await audit(c, { ...ctxOf(req), action: 'student.roll_number', entityType: 'class_enrollments', entityId: rows[0].id, classId: req.params.classId, metadata: { studentId: req.params.sid } });
    return rows[0];
  });
  res.json({ rollNumber: out.roll_number });
}));

// ================================================================ analytics
// GET /classes/:classId/analytics/overview
router.get('/analytics/overview', asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const [view, queue, joins, cls] = await Promise.all([
    loadClassView(pool, classId),
    pool.query(`SELECT entity_type::text AS type, count(*)::int AS n FROM verification_requests WHERE class_id = $1 AND status = 'pending' GROUP BY 1`, [classId]),
    pool.query(`SELECT count(*)::int AS n FROM class_enrollments WHERE class_id = $1 AND status = 'pending'`, [classId]),
    pool.query('SELECT name, current_semester FROM classes WHERE id = $1', [classId]),
  ]);
  const S = view.students;
  const withAtt = S.filter((s) => s.m.held > 0);
  const withMarks = S.filter((s) => s.m.semesterCount > 0);
  const withRole = S.filter((s) => s.m.hasTargetRole);

  // class average SGPA per semester (students who have a verified result for it)
  const bySem = new Map();
  for (const s of S) for (const t of s.m.academics.trend) { if (!bySem.has(t.semester)) bySem.set(t.semester, []); bySem.get(t.semester).push(t.sgpa); }

  const pendingByType = Object.fromEntries(queue.rows.map((r) => [r.type, r.n]));
  res.json({
    class: { id: classId, name: cls.rows[0].name, currentSemester: cls.rows[0].current_semester },
    students: S.length,
    pendingJoinRequests: joins.rows[0].n,
    pendingVerifications: { total: queue.rows.reduce((a, r) => a + r.n, 0), byType: pendingByType },
    averages: {
      cgpa: avg(withMarks.map((s) => s.m.cgpa)),
      attendancePct: avg(withAtt.map((s) => s.m.attendancePct)),
      placementReadiness: avg(S.map((s) => s.placement)),
      verifiedSkillGapPct: avg(withRole.map((s) => s.m.verifiedGapPct)),
      resumeScore: avg(S.filter((s) => s.m.resumeScore != null).map((s) => s.m.resumeScore)),
    },
    passPct: withMarks.length ? scoring.round((100 * withMarks.filter((s) => s.m.activeBacklogs === 0).length) / withMarks.length) : null,
    withBacklogs: withMarks.filter((s) => s.m.activeBacklogs > 0).length,
    belowAttendance: withAtt.filter((s) => s.m.attendancePct < ATTENDANCE_THRESHOLD).length,
    attendanceDistribution: [...bucketise(withAtt.map((s) => s.m.attendancePct), [60, 75, 85], (x) => `${x}%`), { label: 'No data', count: S.length - withAtt.length }],
    cgpaDistribution: bucketise(withMarks.map((s) => s.m.cgpa), [5, 6, 7, 8, 9]),
    sgpaTrend: [...bySem.entries()].sort((a, b) => a[0] - b[0]).map(([semester, v]) => ({ semester, avgSgpa: avg(v), students: v.length })),
    certificates: { verified: S.reduce((a, s) => a + s.m.certCount, 0), perStudent: S.length ? scoring.round(S.reduce((a, s) => a + s.m.certCount, 0) / S.length) : 0 },
    projects: S.reduce((a, s) => a + s.m.projectCount, 0),
    risk: Object.fromEntries(['low', 'medium', 'high', 'unknown'].map((b) => [b, S.filter((s) => s.risk.band === b).length])),
    leaderboardTop: S.slice(0, 3).map((s) => ({ rank: s.rank, name: s.name, score: s.total })),
  });
}));

// GET /classes/:classId/analytics/subjects?semester=
router.get('/analytics/subjects', validate({ query: semesterQ }), asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const sem = req.query.semester ?? (await pool.query('SELECT current_semester FROM classes WHERE id = $1', [classId])).rows[0].current_semester;
  const [marks, att] = await Promise.all([
    pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (m.student_id, m.subject_id) m.* FROM marks m
           JOIN class_enrollments e ON e.student_id = m.student_id AND e.class_id = $1 AND e.status = 'approved'
           JOIN subjects s ON s.id = m.subject_id AND s.class_id = $1
          WHERE m.verification_status = 'verified' ORDER BY m.student_id, m.subject_id, m.attempt DESC)
       SELECT s.id, s.code, s.name, s.semester, s.credits, count(l.*)::int AS students,
              round(avg(100.0 * (l.internal_obtained + l.external_obtained) / NULLIF(l.internal_max + l.external_max, 0)), 1) AS avg_pct,
              count(l.*) FILTER (WHERE l.is_pass)::int AS passed, max(100.0 * (l.internal_obtained + l.external_obtained) / NULLIF(l.internal_max + l.external_max, 0)) AS best_pct
         FROM subjects s LEFT JOIN latest l ON l.subject_id = s.id WHERE s.class_id = $1 AND s.semester = $2 GROUP BY s.id ORDER BY s.code`, [classId, sem]),
    pool.query(
      `SELECT a.subject_id, count(*)::int AS held, count(*) FILTER (WHERE a.status IN ('present','late','excused'))::int AS attended
         FROM attendance_records a JOIN class_enrollments e ON e.student_id = a.student_id AND e.class_id = $1 AND e.status = 'approved'
        WHERE a.class_id = $1 AND a.verification_status = 'verified' GROUP BY a.subject_id`, [classId]),
  ]);
  const attBy = new Map(att.rows.map((r) => [r.subject_id, r]));
  res.json({
    semester: sem,
    subjects: marks.rows.map((r) => {
      const a = attBy.get(r.id);
      return {
        id: r.id, code: r.code, name: r.name, credits: Number(r.credits), students: r.students,
        avgPercentage: r.avg_pct == null ? null : Number(r.avg_pct), bestPercentage: r.best_pct == null ? null : scoring.round(Number(r.best_pct), 1),
        passPct: r.students ? scoring.round((100 * r.passed) / r.students, 1) : null,
        attendancePct: a ? scoring.pct(a.attended, a.held) : null,
      };
    }),
  });
}));

// GET /classes/:classId/analytics/performers?n=5
router.get('/analytics/performers', validate({ query: z.object({ n: z.coerce.number().int().min(1).max(20).default(5) }) }), asyncHandler(async (req, res) => {
  const view = await loadClassView(pool, req.params.classId);
  const row = (s) => ({ id: s.id, name: s.name, rollNumber: s.rollNumber, rank: s.rank, score: s.total, cgpa: s.m.cgpa, attendancePct: s.m.held ? s.m.attendancePct : null });
  const ranked = view.students.filter((s) => s.hasData);                // a student with no verified data yet is "new", not "bottom"
  res.json({
    top: ranked.slice(0, req.query.n).map(row),
    bottom: [...ranked].reverse().slice(0, Math.min(req.query.n, Math.max(0, ranked.length - req.query.n))).map(row),
    noData: view.students.length - ranked.length,
  });
}));

// GET /classes/:classId/analytics/at-risk
router.get('/analytics/at-risk', asyncHandler(async (req, res) => {
  const view = await loadClassView(pool, req.params.classId);
  const flagged = view.students
    .filter((s) => s.risk.reasons.length > 0 && s.risk.band !== 'unknown')
    .sort((a, b) => (b.risk.score ?? 0) - (a.risk.score ?? 0))
    .map((s) => ({
      id: s.id, name: s.name, rollNumber: s.rollNumber, band: s.risk.band, riskScore: s.risk.score, reasons: s.risk.reasons,
      attendancePct: s.m.held ? s.m.attendancePct : null, cgpa: s.m.cgpa, backlogs: s.m.activeBacklogs,
    }));
  res.json({ students: flagged, threshold: ATTENDANCE_THRESHOLD });
}));

// GET /classes/:classId/analytics/skill-gap — target roles in this class and the skills most often missing
router.get('/analytics/skill-gap', asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const view = await loadClassView(pool, classId);
  const ids = view.students.filter((s) => s.m.hasTargetRole).map((s) => s.id);
  const gaps = ids.length ? (await pool.query(
    `WITH ver AS (
       SELECT ss.student_id, ss.skill_id, max(ss.proficiency) AS lvl FROM student_skills ss
         LEFT JOIN certificates c ON c.id = ss.certificate_id LEFT JOIN portfolio_items p ON p.id = ss.portfolio_id
        WHERE ss.student_id = ANY($1::uuid[]) AND COALESCE(CASE ss.source WHEN 'manual' THEN ss.verification_status = 'verified'
              WHEN 'certificate' THEN c.verification_status = 'verified' ELSE p.verification_status = 'verified' END, false)
        GROUP BY 1, 2)
     SELECT t.role_id, rs.skill_id, k.name AS skill, count(*)::int AS students,
            count(*) FILTER (WHERE COALESCE(v.lvl, 0) < rs.required_level)::int AS lacking
       FROM student_target_roles t JOIN role_skills rs ON rs.role_id = t.role_id JOIN skills k ON k.id = rs.skill_id
       LEFT JOIN ver v ON v.student_id = t.student_id AND v.skill_id = rs.skill_id
      WHERE t.student_id = ANY($1::uuid[]) GROUP BY t.role_id, rs.skill_id, k.name`, [ids])).rows : [];
  const roles = ids.length ? (await pool.query('SELECT id, name FROM career_roles WHERE id = ANY($1::uuid[])', [[...new Set(view.students.map((s) => s.m.targetRoleId).filter(Boolean))]])).rows : [];
  res.json({
    withoutTarget: view.students.length - ids.length,
    roles: roles.map((r) => {
      const mine = view.students.filter((s) => s.m.targetRoleId === r.id);
      return {
        roleId: r.id, role: r.name, students: mine.length, avgVerifiedGapPct: avg(mine.map((s) => s.m.verifiedGapPct)),
        mostMissing: gaps.filter((g) => g.role_id === r.id && g.lacking > 0).sort((a, b) => b.lacking - a.lacking).slice(0, 5)
          .map((g) => ({ skill: g.skill, lacking: g.lacking, of: g.students })),
      };
    }).sort((a, b) => b.students - a.students),
  });
}));

// GET /classes/:classId/compare?studentIds=a,b,c
router.get('/compare', validate({ query: z.object({ studentIds: z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(uuid).min(2).max(4)) }) }), asyncHandler(async (req, res) => {
  const view = await loadClassView(pool, req.params.classId);
  const picked = req.query.studentIds.map((id) => view.students.find((s) => s.id === id));
  if (picked.some((s) => !s)) throw notFound('Student');
  res.json({
    weights: view.weights,
    students: picked.map((s) => ({
      id: s.id, name: s.name, rollNumber: s.rollNumber, rank: s.rank, score: s.total, components: s.components,
      cgpa: s.m.cgpa, attendancePct: s.m.held ? s.m.attendancePct : null, backlogs: s.m.activeBacklogs, certificates: s.m.certCount, projects: s.m.projectCount,
      placementReadiness: s.placement, verifiedSkillGapPct: s.m.hasTargetRole ? s.m.verifiedGapPct : null, risk: s.risk.band,
    })),
  });
}));

// ================================================================ leaderboard
// GET /classes/:classId/leaderboard?semester=
router.get('/leaderboard', validate({ query: semesterQ }), asyncHandler(async (req, res) => {
  const view = await loadClassView(pool, req.params.classId, { semester: req.query.semester ?? null });
  res.json({
    semester: req.query.semester ?? null, weights: view.weights, weightsSource: view.source,
    board: view.students.map((s) => ({
      rank: s.rank, id: s.id, name: s.name, rollNumber: s.rollNumber, score: s.total, components: s.components,
      cgpa: s.m.cgpa, attendancePct: s.m.held ? s.m.attendancePct : null,
    })),
  });
}));

const weightsBody = z.object({
  marks: z.number().int().min(0).max(100), attendance: z.number().int().min(0).max(100), certificates: z.number().int().min(0).max(100),
  skills: z.number().int().min(0).max(100), resume: z.number().int().min(0).max(100), activity: z.number().int().min(0).max(100),
}).refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === 100, { message: 'Weights must add up to exactly 100' });

// GET /classes/:classId/leaderboard-config
router.get('/leaderboard-config', asyncHandler(async (req, res) => {
  const w = await getWeights(pool, req.params.classId);
  res.json({ ...w, defaults: scoring.DEFAULT_LEADERBOARD_WEIGHTS });
}));

// PUT /classes/:classId/leaderboard-config  { marks, attendance, certificates, skills, resume, activity } (sum = 100)
router.put('/leaderboard-config', validate({ body: weightsBody }), asyncHandler(async (req, res) => {
  const w = req.body;
  await tx(async (c) => {
    await c.query(
      `INSERT INTO leaderboard_configs (class_id, w_marks, w_attendance, w_certificates, w_skills, w_resume, w_activity, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (class_id) DO UPDATE SET w_marks = EXCLUDED.w_marks, w_attendance = EXCLUDED.w_attendance, w_certificates = EXCLUDED.w_certificates,
         w_skills = EXCLUDED.w_skills, w_resume = EXCLUDED.w_resume, w_activity = EXCLUDED.w_activity, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.params.classId, w.marks, w.attendance, w.certificates, w.skills, w.resume, w.activity, req.user.id]);
    await audit(c, { ...ctxOf(req), action: 'leaderboard.configure', entityType: 'leaderboard_configs', classId: req.params.classId, metadata: w });
  });
  res.json({ ...(await getWeights(pool, req.params.classId)), defaults: scoring.DEFAULT_LEADERBOARD_WEIGHTS });
}));

// DELETE /classes/:classId/leaderboard-config — fall back to the college default
router.delete('/leaderboard-config', asyncHandler(async (req, res) => {
  await tx(async (c) => {
    await c.query('DELETE FROM leaderboard_configs WHERE class_id = $1', [req.params.classId]);
    await audit(c, { ...ctxOf(req), action: 'leaderboard.reset', entityType: 'leaderboard_configs', classId: req.params.classId });
  });
  res.json({ ...(await getWeights(pool, req.params.classId)), defaults: scoring.DEFAULT_LEADERBOARD_WEIGHTS });
}));

// ================================================================ CSV exports
const EXPORTS = {
  async students(classId) {
    const v = await loadClassView(pool, classId);
    const emails = new Map((await pool.query(`SELECT e.student_id, u.email::text AS email FROM class_enrollments e JOIN users u ON u.id = e.student_id WHERE e.class_id = $1`, [classId])).rows.map((r) => [r.student_id, r.email]));
    return [['roll_number', 'name', 'email', 'rank', 'score', 'cgpa', 'attendance_pct', 'active_backlogs', 'verified_certificates', 'verified_projects', 'placement_readiness', 'risk'],
      v.students.map((s) => [s.rollNumber, s.name, emails.get(s.id), s.rank, s.total, s.m.cgpa, s.m.held ? s.m.attendancePct : '', s.m.activeBacklogs, s.m.certCount, s.m.projectCount, s.placement, s.risk.band])];
  },
  async leaderboard(classId) {
    const v = await loadClassView(pool, classId);
    return [['rank', 'roll_number', 'name', 'score', ...Object.keys(v.weights).map((k) => `${k}_component`)],
      v.students.map((s) => [s.rank, s.rollNumber, s.name, s.total, ...Object.keys(v.weights).map((k) => s.components[k])])];
  },
  async attendance(classId) {
    const { rows } = await pool.query(
      `SELECT e.roll_number, u.full_name, s.code, s.name AS subject, s.semester,
              count(*) FILTER (WHERE a.status IN ('present','late','excused'))::int AS attended, count(*)::int AS held
         FROM attendance_records a JOIN subjects s ON s.id = a.subject_id JOIN users u ON u.id = a.student_id
         JOIN class_enrollments e ON e.student_id = a.student_id AND e.class_id = $1 AND e.status = 'approved'
        WHERE a.class_id = $1 AND a.verification_status = 'verified' GROUP BY e.roll_number, u.full_name, s.id ORDER BY e.roll_number NULLS LAST, u.full_name, s.semester, s.code`, [classId]);
    return [['roll_number', 'name', 'semester', 'subject_code', 'subject', 'attended', 'held', 'percentage'],
      rows.map((r) => [r.roll_number, r.full_name, r.semester, r.code, r.subject, r.attended, r.held, scoring.pct(r.attended, r.held)])];
  },
  async marks(classId) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (m.student_id, m.subject_id) e.roll_number, u.full_name, s.code, s.name AS subject, s.semester, m.attempt,
              m.internal_obtained, m.internal_max, m.external_obtained, m.external_max, m.grade, m.is_pass
         FROM marks m JOIN subjects s ON s.id = m.subject_id AND s.class_id = $1 JOIN users u ON u.id = m.student_id
         JOIN class_enrollments e ON e.student_id = m.student_id AND e.class_id = $1 AND e.status = 'approved'
        WHERE m.verification_status = 'verified' ORDER BY m.student_id, m.subject_id, m.attempt DESC`, [classId]);
    rows.sort((a, b) => String(a.roll_number).localeCompare(String(b.roll_number)) || a.semester - b.semester || a.code.localeCompare(b.code));
    return [['roll_number', 'name', 'semester', 'subject_code', 'subject', 'attempt', 'internal', 'internal_max', 'external', 'external_max', 'grade', 'result'],
      rows.map((r) => [r.roll_number, r.full_name, r.semester, r.code, r.subject, r.attempt, r.internal_obtained, r.internal_max, r.external_obtained, r.external_max, r.grade, r.is_pass ? 'pass' : 'fail'])];
  },
};

// GET /classes/:classId/export/:kind  → text/csv  (students | leaderboard | attendance | marks)
router.get('/export/:kind', validate({ params: z.object({ classId: uuid, kind: z.enum(Object.keys(EXPORTS)) }) }), asyncHandler(async (req, res) => {
  const [headers, rows] = await EXPORTS[req.params.kind](req.params.classId);
  await audit(pool, { ...ctxOf(req), action: 'report.export', entityType: 'class', entityId: req.params.classId, classId: req.params.classId, metadata: { kind: req.params.kind, rows: rows.length } });
  res.type('text/csv').set('Content-Disposition', `attachment; filename="class-${req.params.kind}.csv"`).send(csv.toCsv(headers, rows));
}));

module.exports = router;
