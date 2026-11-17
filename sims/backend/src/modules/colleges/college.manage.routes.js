'use strict';
/**
 * College admin: profile, departments, instructor assignment, events, announcements, default leaderboard weights.
 * Mounted at /college. (Instructor approve / reject / remove and department creation live in colleges.routes.js.)
 */
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notifyMany } = require('../../utils/notify');
const { requireActiveCollege } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const { collegeWeights } = require('./college.insights');

const uuid = z.string().uuid();
const text = (min, max) => z.string().trim().min(min).max(max);
const idParam = z.object({ id: uuid });

// ================================================================ college profile
const patchCollege = z.object({
  name: text(2, 160), address: z.string().trim().max(300).nullable(), affiliation: z.string().trim().max(160).nullable(),
  principalName: text(2, 120), contactEmail: z.string().trim().toLowerCase().email().nullable(), contactPhone: z.string().trim().max(30).nullable(),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// PATCH /college   (a suspended college can still be corrected, so no requireActiveCollege here)
router.patch('/', validate({ body: patchCollege }), asyncHandler(async (req, res) => {
  const map = { name: 'name', address: 'address', affiliation: 'affiliation', principalName: 'principal_name', contactEmail: 'contact_email', contactPhone: 'contact_phone' };
  const sets = ['updated_at = now()']; const vals = [req.scope.collegeId];
  for (const [k, col] of Object.entries(map)) if (k in req.body) { vals.push(req.body[k]); sets.push(`${col} = $${vals.length}`); }   // column names come from the fixed map
  const row = await tx(async (c) => {
    const r = (await c.query(`UPDATE colleges SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, address, affiliation, principal_name, contact_email, contact_phone, status`, vals)).rows[0];
    await audit(c, { ...ctxOf(req), action: 'college.update', entityType: 'college', entityId: r.id, metadata: req.body });
    return r;
  });
  res.json({ college: row });
}));

router.use(requireActiveCollege);

// ================================================================ departments
// GET /college/departments — with class / student / instructor counts
router.get('/departments', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.code, d.hod_name,
            (SELECT count(*)::int FROM classes c WHERE c.department_id = d.id AND c.status = 'active') AS classes,
            (SELECT count(*)::int FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE c.department_id = d.id AND c.status = 'active' AND e.status = 'approved') AS students,
            (SELECT count(DISTINCT c.instructor_id)::int FROM classes c WHERE c.department_id = d.id AND c.status = 'active') AS instructors
       FROM departments d WHERE d.college_id = $1 ORDER BY d.name`, [req.scope.collegeId]);
  res.json({ departments: rows });
}));

const patchDept = z.object({ name: text(2, 120), code: z.string().trim().toUpperCase().min(2).max(12), hodName: z.string().trim().max(120).nullable() })
  .partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// PATCH /college/departments/:id   (duplicate code → 409 CONFLICT)
router.patch('/departments/:id', validate({ params: idParam, body: patchDept }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await pool.query(
    `UPDATE departments SET name = COALESCE($3, name), code = COALESCE($4, code), hod_name = CASE WHEN $5::boolean THEN $6 ELSE hod_name END
      WHERE id = $1 AND college_id = $2 RETURNING id, name, code, hod_name`,
    [req.params.id, req.scope.collegeId, b.name ?? null, b.code ?? null, 'hodName' in b, b.hodName ?? null]);
  if (!rows[0]) throw notFound('Department');
  await audit(pool, { ...ctxOf(req), action: 'department.update', entityType: 'department', entityId: rows[0].id, metadata: b });
  res.json({ department: rows[0] });
}));

// DELETE /college/departments/:id — only while no class uses it
router.delete('/departments/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  await tx(async (c) => {
    const d = (await c.query('SELECT id FROM departments WHERE id = $1 AND college_id = $2 FOR UPDATE', [req.params.id, req.scope.collegeId])).rows[0];
    if (!d) throw notFound('Department');
    const used = (await c.query('SELECT count(*)::int AS n FROM classes WHERE department_id = $1', [d.id])).rows[0].n;
    if (used) throw new AppError(409, 'DEPARTMENT_IN_USE', `${used} class${used === 1 ? ' still belongs' : 'es still belong'} to this department`);
    await c.query('UPDATE college_instructors SET department_id = NULL WHERE department_id = $1', [d.id]);
    await c.query('DELETE FROM departments WHERE id = $1', [d.id]);
    await audit(c, { ...ctxOf(req), action: 'department.delete', entityType: 'department', entityId: d.id });
  });
  res.status(204).end();
}));

// PATCH /college/instructors/:id  { departmentId | null } — assign an instructor to a department
router.patch('/instructors/:id', validate({ params: idParam, body: z.object({ departmentId: uuid.nullable() }) }), asyncHandler(async (req, res) => {
  const out = await tx(async (c) => {
    if (req.body.departmentId) {
      const ok = (await c.query('SELECT 1 FROM departments WHERE id = $1 AND college_id = $2', [req.body.departmentId, req.scope.collegeId])).rows[0];
      if (!ok) throw badRequest('INVALID_DEPARTMENT', 'That department does not belong to your college');
    }
    const r = (await c.query('UPDATE college_instructors SET department_id = $3 WHERE id = $1 AND college_id = $2 RETURNING id, department_id', [req.params.id, req.scope.collegeId, req.body.departmentId])).rows[0];
    if (!r) throw notFound('Instructor');
    await audit(c, { ...ctxOf(req), action: 'instructor.assign_department', entityType: 'college_instructors', entityId: r.id, metadata: { departmentId: req.body.departmentId } });
    return r;
  });
  res.json({ membership: out });
}));

// ================================================================ default leaderboard weights
const weightsBody = z.object({
  marks: z.number().int().min(0).max(100), attendance: z.number().int().min(0).max(100), certificates: z.number().int().min(0).max(100),
  skills: z.number().int().min(0).max(100), resume: z.number().int().min(0).max(100), activity: z.number().int().min(0).max(100),
}).refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === 100, { message: 'Weights must add up to exactly 100' });

const weightsOut = async (collegeId) => ({ ...(await collegeWeights(pool, collegeId)), defaults: scoring.DEFAULT_LEADERBOARD_WEIGHTS,
  overridden: (await pool.query('SELECT count(*)::int AS n FROM leaderboard_configs lc JOIN classes c ON c.id = lc.class_id WHERE c.college_id = $1', [collegeId])).rows[0].n });

// GET|PUT|DELETE /college/leaderboard-config — the default for classes that have no weights of their own (`overridden` counts those that do)
router.get('/leaderboard-config', asyncHandler(async (req, res) => res.json(await weightsOut(req.scope.collegeId))));
router.put('/leaderboard-config', validate({ body: weightsBody }), asyncHandler(async (req, res) => {
  const w = req.body;
  await tx(async (c) => {
    await c.query(
      `INSERT INTO leaderboard_configs (college_id, w_marks, w_attendance, w_certificates, w_skills, w_resume, w_activity, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (college_id) DO UPDATE SET w_marks = EXCLUDED.w_marks, w_attendance = EXCLUDED.w_attendance, w_certificates = EXCLUDED.w_certificates,
         w_skills = EXCLUDED.w_skills, w_resume = EXCLUDED.w_resume, w_activity = EXCLUDED.w_activity, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.scope.collegeId, w.marks, w.attendance, w.certificates, w.skills, w.resume, w.activity, req.user.id]);
    await audit(c, { ...ctxOf(req), action: 'leaderboard.college_configure', entityType: 'leaderboard_configs', metadata: w });
  });
  res.json(await weightsOut(req.scope.collegeId));
}));
router.delete('/leaderboard-config', asyncHandler(async (req, res) => {
  await tx(async (c) => {
    await c.query('DELETE FROM leaderboard_configs WHERE college_id = $1', [req.scope.collegeId]);
    await audit(c, { ...ctxOf(req), action: 'leaderboard.college_reset', entityType: 'leaderboard_configs' });
  });
  res.json(await weightsOut(req.scope.collegeId));
}));

// ================================================================ people to notify
const studentIds = async (db, collegeId) => (await db.query(
  `SELECT e.student_id FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE c.college_id = $1 AND c.status = 'active' AND e.status = 'approved'`, [collegeId])).rows.map((r) => r.student_id);
const instructorIds = async (db, collegeId) => (await db.query(
  `SELECT user_id FROM college_instructors WHERE college_id = $1 AND status = 'approved'`, [collegeId])).rows.map((r) => r.user_id);

// ================================================================ announcements (broadcast to every class)
// GET /college/announcements
router.get('/announcements', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.body, a.is_pinned, a.created_at, u.full_name AS author FROM announcements a JOIN users u ON u.id = a.author_id
      WHERE a.college_id = $1 ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT 100`, [req.scope.collegeId]);
  res.json({ announcements: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, pinned: r.is_pinned, createdAt: r.created_at, author: r.author })) });
}));

// POST /college/announcements — shown on every student's dashboard; students and instructors get a notification
router.post('/announcements', validate({ body: z.object({ title: text(2, 150), body: text(2, 2000), pinned: z.boolean().default(false) }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  const out = await tx(async (c) => {
    const a = (await c.query(
      `INSERT INTO announcements (scope, college_id, title, body, is_pinned, author_id) VALUES ('college',$1,$2,$3,$4,$5) RETURNING id, title, body, is_pinned, created_at`,
      [req.scope.collegeId, b.title, b.body, b.pinned, req.user.id])).rows[0];
    const [stu, ins] = await Promise.all([studentIds(c, req.scope.collegeId), instructorIds(c, req.scope.collegeId)]);
    await notifyMany(c, stu, { type: 'announcement', title: b.title, body: b.body.slice(0, 200), link: '/student/activities' });
    await notifyMany(c, ins, { type: 'announcement', title: b.title, body: b.body.slice(0, 200), link: '/class' });
    await audit(c, { ...ctxOf(req), action: 'announcement.create', entityType: 'announcements', entityId: a.id, metadata: { scope: 'college', recipients: stu.length + ins.length } });
    return { a, recipients: stu.length + ins.length };
  });
  res.status(201).json({ announcement: { id: out.a.id, title: out.a.title, body: out.a.body, pinned: out.a.is_pinned, createdAt: out.a.created_at }, recipients: out.recipients });
}));

router.patch('/announcements/:id', validate({ params: idParam, body: z.object({ pinned: z.boolean() }) }), asyncHandler(async (req, res) => {
  const { rows } = await pool.query('UPDATE announcements SET is_pinned = $3 WHERE id = $1 AND college_id = $2 RETURNING id, is_pinned', [req.params.id, req.scope.collegeId, req.body.pinned]);
  if (!rows[0]) throw notFound('Announcement');
  res.json({ id: rows[0].id, pinned: rows[0].is_pinned });
}));

router.delete('/announcements/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM announcements WHERE id = $1 AND college_id = $2', [req.params.id, req.scope.collegeId]);
  if (!rowCount) throw notFound('Announcement');
  await audit(pool, { ...ctxOf(req), action: 'announcement.delete', entityType: 'announcements', entityId: req.params.id });
  res.status(204).end();
}));

// ================================================================ events (calendar + create for many classes)
// GET /college/events?from=&to=&departmentId=
router.get('/events', validate({ query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), departmentId: uuid.optional() }) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const { rows } = await pool.query(
    `SELECT a.id, a.type, a.title, a.venue, a.starts_at, a.ends_at, a.is_published, c.id AS class_id, c.name AS class_name, d.id AS department_id, d.name AS department,
            count(p.*)::int AS registered, count(p.*) FILTER (WHERE p.status IN ('attended','runner_up','winner'))::int AS attended
       FROM activities a JOIN classes c ON c.id = a.class_id JOIN departments d ON d.id = a.department_id LEFT JOIN activity_participants p ON p.activity_id = a.id
      WHERE a.college_id = $1 AND ($2::timestamptz IS NULL OR a.starts_at >= $2) AND ($3::timestamptz IS NULL OR a.starts_at <= $3) AND ($4::uuid IS NULL OR a.department_id = $4)
      GROUP BY a.id, c.id, d.id ORDER BY a.starts_at DESC LIMIT 500`, [req.scope.collegeId, q.from ?? null, q.to ?? null, q.departmentId ?? null]);
  res.json({ events: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, venue: r.venue, startsAt: r.starts_at, endsAt: r.ends_at, published: r.is_published, class: { id: r.class_id, name: r.class_name }, department: { id: r.department_id, name: r.department }, registered: r.registered, attended: r.attended })) });
}));

const eventBody = z.object({
  type: z.enum(['program', 'event', 'competition', 'course', 'workshop']), title: text(2, 150),
  description: z.string().trim().max(2000).optional(), venue: z.string().trim().max(150).optional(),
  startsAt: z.coerce.date(), endsAt: z.coerce.date().optional(), departmentId: uuid.optional(),
}).refine((e) => !e.endsAt || e.endsAt > e.startsAt, { path: ['endsAt'], message: 'End must be after the start' });

// POST /college/events — one PUBLISHED activity per active class (of the department, or all). Each class's instructor can then
// edit it and mark attendance on their own Activities page.
router.post('/events', validate({ body: eventBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const out = await tx(async (c) => {
    if (b.departmentId && !(await c.query('SELECT 1 FROM departments WHERE id = $1 AND college_id = $2', [b.departmentId, req.scope.collegeId])).rows[0]) throw notFound('Department');
    const classes = (await c.query(
      `SELECT id, department_id FROM classes WHERE college_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR department_id = $2)`, [req.scope.collegeId, b.departmentId ?? null])).rows;
    if (!classes.length) throw badRequest('NO_CLASSES', 'There are no active classes to publish this event to');
    for (const k of classes) {
      await c.query(
        `INSERT INTO activities (class_id, college_id, department_id, type, title, description, venue, starts_at, ends_at, is_published, published_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,now(),$10)`,
        [k.id, req.scope.collegeId, k.department_id, b.type, b.title, b.description ?? null, b.venue ?? null, b.startsAt, b.endsAt ?? null, req.user.id]);
    }
    const stu = (await c.query(
      `SELECT e.student_id FROM class_enrollments e WHERE e.class_id = ANY($1::uuid[]) AND e.status = 'approved'`, [classes.map((k) => k.id)])).rows.map((r) => r.student_id);
    await notifyMany(c, stu, { type: 'activity', title: `New ${b.type}: ${b.title}`, body: b.venue ? `At ${b.venue}` : null, link: '/student/activities' });
    await audit(c, { ...ctxOf(req), action: 'event.create', entityType: 'activities', metadata: { title: b.title, classes: classes.length, students: stu.length } });
    return { classes: classes.length, students: stu.length };
  });
  res.status(201).json({ created: out.classes, notified: out.students });
}));

module.exports = router;
