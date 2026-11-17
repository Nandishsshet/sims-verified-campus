'use strict';
/**
 * Class life — /classes/:classId/{announcements,activities,assignments,students/:sid/notes,
 * parent-notifications,audit-logs}. Anything students see is delivered as a notification too.
 */
const { z } = require('zod');
const router = require('express').Router({ mergeParams: true });
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notifyMany } = require('../../utils/notify');
const mailer = require('../../utils/mailer');
const { validate } = require('../../middleware/validate');

const uuid = z.string().uuid();
const cid = z.object({ classId: uuid });
const text = (min, max) => z.string().trim().min(min).max(max);

/** Approved students of the class. */
const studentIds = async (db, classId) =>
  (await db.query(`SELECT student_id FROM class_enrollments WHERE class_id = $1 AND status = 'approved'`, [classId])).rows.map((r) => r.student_id);

// ================================================================ announcements
// GET /classes/:classId/announcements
router.get('/announcements', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.body, a.is_pinned, a.created_at, u.full_name AS author FROM announcements a JOIN users u ON u.id = a.author_id
      WHERE a.class_id = $1 ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT 100`, [req.params.classId]);
  res.json({ announcements: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, pinned: r.is_pinned, createdAt: r.created_at, author: r.author })) });
}));

// POST /classes/:classId/announcements — visible on every student's dashboard + a notification each
router.post('/announcements', validate({ body: z.object({ title: text(2, 150), body: text(2, 2000), pinned: z.boolean().default(false) }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    const r = (await c.query(
      `INSERT INTO announcements (scope, class_id, title, body, is_pinned, author_id) VALUES ('class',$1,$2,$3,$4,$5) RETURNING id, title, body, is_pinned, created_at`,
      [req.params.classId, b.title, b.body, b.pinned, req.user.id])).rows[0];
    await notifyMany(c, await studentIds(c, req.params.classId), { type: 'announcement', title: b.title, body: b.body.slice(0, 200), link: '/student/activities' });
    await audit(c, { ...ctxOf(req), action: 'announcement.create', entityType: 'announcements', entityId: r.id, classId: req.params.classId });
    return r;
  });
  res.status(201).json({ announcement: { id: row.id, title: row.title, body: row.body, pinned: row.is_pinned, createdAt: row.created_at } });
}));

// PATCH /classes/:classId/announcements/:id  { pinned }
router.patch('/announcements/:id', validate({ params: z.object({ classId: uuid, id: uuid }), body: z.object({ pinned: z.boolean() }) }), asyncHandler(async (req, res) => {
  const { rows } = await pool.query('UPDATE announcements SET is_pinned = $3 WHERE id = $1 AND class_id = $2 RETURNING id, is_pinned', [req.params.id, req.params.classId, req.body.pinned]);
  if (!rows[0]) throw notFound('Announcement');
  res.json({ id: rows[0].id, pinned: rows[0].is_pinned });
}));

// DELETE /classes/:classId/announcements/:id
router.delete('/announcements/:id', validate({ params: z.object({ classId: uuid, id: uuid }) }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM announcements WHERE id = $1 AND class_id = $2', [req.params.id, req.params.classId]);
  if (!rowCount) throw notFound('Announcement');
  await audit(pool, { ...ctxOf(req), action: 'announcement.delete', entityType: 'announcements', entityId: req.params.id, classId: req.params.classId });
  res.status(204).end();
}));

// ================================================================ activities
const activityFields = {
  type: z.enum(['program', 'event', 'competition', 'course', 'workshop']),
  title: text(2, 150),
  description: z.string().trim().max(2000).nullable(),
  venue: z.string().trim().max(150).nullable(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable(),
};
const createActivity = z.object({ ...activityFields, description: activityFields.description.optional(), venue: activityFields.venue.optional(), endsAt: activityFields.endsAt.optional() })
  .refine((a) => !a.endsAt || a.endsAt > a.startsAt, { path: ['endsAt'], message: 'End must be after the start' });
const patchActivity = z.object(activityFields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const actDto = (r) => ({
  id: r.id, type: r.type, title: r.title, description: r.description, venue: r.venue, startsAt: r.starts_at, endsAt: r.ends_at,
  published: r.is_published, publishedAt: r.published_at, registered: r.registered ?? 0, attended: r.attended ?? 0,
});

// GET /classes/:classId/activities
router.get('/activities', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, count(p.*)::int AS registered, count(p.*) FILTER (WHERE p.status IN ('attended','runner_up','winner'))::int AS attended
       FROM activities a LEFT JOIN activity_participants p ON p.activity_id = a.id WHERE a.class_id = $1 GROUP BY a.id ORDER BY a.starts_at DESC`, [req.params.classId]);
  res.json({ activities: rows.map(actDto) });
}));

// POST /classes/:classId/activities — created as a draft; publish to show it to students
router.post('/activities', validate({ body: createActivity }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    const cls = (await c.query('SELECT college_id, department_id FROM classes WHERE id = $1', [req.params.classId])).rows[0];
    const r = (await c.query(
      `INSERT INTO activities (class_id, college_id, department_id, type, title, description, venue, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.classId, cls.college_id, cls.department_id, b.type, b.title, b.description ?? null, b.venue ?? null, b.startsAt, b.endsAt ?? null, req.user.id])).rows[0];
    await audit(c, { ...ctxOf(req), action: 'activity.create', entityType: 'activities', entityId: r.id, classId: req.params.classId });
    return r;
  });
  res.status(201).json({ activity: actDto(row) });
}));

async function ownActivity(db, classId, id) {
  const a = (await db.query('SELECT * FROM activities WHERE id = $1 AND class_id = $2', [id, classId])).rows[0];
  if (!a) throw notFound('Activity');
  return a;
}
const actParam = z.object({ classId: uuid, aid: uuid });

// PATCH /classes/:classId/activities/:aid
router.patch('/activities/:aid', validate({ params: actParam, body: patchActivity }), asyncHandler(async (req, res) => {
  const b = req.body;
  const cur = await ownActivity(pool, req.params.classId, req.params.aid);
  const starts = b.startsAt ?? cur.starts_at; const ends = b.endsAt === undefined ? cur.ends_at : b.endsAt;
  if (ends && new Date(ends) <= new Date(starts)) throw badRequest('INVALID_DATES', 'End must be after the start');
  const { rows } = await pool.query(
    `UPDATE activities SET type = COALESCE($2, type), title = COALESCE($3, title), description = CASE WHEN $4::boolean THEN $5 ELSE description END,
            venue = CASE WHEN $6::boolean THEN $7 ELSE venue END, starts_at = $8, ends_at = $9 WHERE id = $1 RETURNING *`,
    [cur.id, b.type ?? null, b.title ?? null, 'description' in b, b.description ?? null, 'venue' in b, b.venue ?? null, starts, ends]);
  res.json({ activity: actDto(rows[0]) });
}));

// DELETE /classes/:classId/activities/:aid
router.delete('/activities/:aid', validate({ params: actParam }), asyncHandler(async (req, res) => {
  const cur = await ownActivity(pool, req.params.classId, req.params.aid);
  await pool.query('DELETE FROM activities WHERE id = $1', [cur.id]);
  await audit(pool, { ...ctxOf(req), action: 'activity.delete', entityType: 'activities', entityId: cur.id, classId: req.params.classId });
  res.status(204).end();
}));

// POST /classes/:classId/activities/:aid/publish | unpublish
for (const verb of ['publish', 'unpublish']) {
  router.post(`/activities/:aid/${verb}`, validate({ params: actParam }), asyncHandler(async (req, res) => {
    const out = await tx(async (c) => {
      const cur = await ownActivity(c, req.params.classId, req.params.aid);
      const publish = verb === 'publish';
      if (cur.is_published === publish) throw new AppError(409, 'INVALID_STATE', `This activity is already ${publish ? 'published' : 'a draft'}`);
      const r = (await c.query('UPDATE activities SET is_published = $2, published_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING *', [cur.id, publish])).rows[0];
      if (publish) await notifyMany(c, await studentIds(c, req.params.classId), { type: 'activity', title: `New: ${cur.title}`, body: `${cur.type} · ${new Date(cur.starts_at).toDateString()}`, link: '/student/activities' });
      await audit(c, { ...ctxOf(req), action: `activity.${verb}`, entityType: 'activities', entityId: cur.id, classId: req.params.classId });
      return r;
    });
    res.json({ activity: actDto(out) });
  }));
}

// GET /classes/:classId/activities/:aid/participants — every approved student with their status (null = not registered)
router.get('/activities/:aid/participants', validate({ params: actParam }), asyncHandler(async (req, res) => {
  const a = await ownActivity(pool, req.params.classId, req.params.aid);
  const { rows } = await pool.query(
    `SELECT e.student_id, u.full_name, e.roll_number, p.status, p.remarks FROM class_enrollments e JOIN users u ON u.id = e.student_id
       LEFT JOIN activity_participants p ON p.activity_id = $2 AND p.student_id = e.student_id
      WHERE e.class_id = $1 AND e.status = 'approved' ORDER BY e.roll_number NULLS LAST, u.full_name`, [req.params.classId, a.id]);
  res.json({ activity: actDto(a), participants: rows.map((r) => ({ studentId: r.student_id, name: r.full_name, rollNumber: r.roll_number, status: r.status, remarks: r.remarks })) });
}));

// PUT /classes/:classId/activities/:aid/participants  { entries: [{studentId, status, remarks?}] } — attended / winner …
router.put('/activities/:aid/participants', validate({ params: actParam, body: z.object({
  entries: z.array(z.object({ studentId: uuid, status: z.enum(['registered', 'attended', 'absent', 'runner_up', 'winner']), remarks: z.string().trim().max(300).optional() })).min(1).max(500),
}) }), asyncHandler(async (req, res) => {
  const out = await tx(async (c) => {
    const a = await ownActivity(c, req.params.classId, req.params.aid);
    const ids = req.body.entries.map((e) => e.studentId);
    const ok = (await c.query(`SELECT count(*)::int AS n FROM class_enrollments WHERE class_id = $1 AND status = 'approved' AND student_id = ANY($2::uuid[])`, [req.params.classId, ids])).rows[0].n;
    if (ok !== new Set(ids).size) throw badRequest('INVALID_STUDENT', 'Some students are not approved members of this class');
    for (const e of req.body.entries) {
      await c.query(
        `INSERT INTO activity_participants (activity_id, student_id, status, remarks) VALUES ($1,$2,$3,$4)
         ON CONFLICT (activity_id, student_id) DO UPDATE SET status = EXCLUDED.status, remarks = EXCLUDED.remarks, updated_at = now()`,
        [a.id, e.studentId, e.status, e.remarks ?? null]);
    }
    await audit(c, { ...ctxOf(req), action: 'activity.participants', entityType: 'activities', entityId: a.id, classId: req.params.classId, metadata: { count: req.body.entries.length } });
    return req.body.entries.length;
  });
  res.json({ saved: out });
}));

// ================================================================ assignments
const assignFields = { title: text(2, 150), description: z.string().trim().max(2000).nullable(), dueAt: z.coerce.date(), subjectId: uuid.nullable() };
const createAssignment = z.object({ ...assignFields, description: assignFields.description.optional(), subjectId: assignFields.subjectId.optional() });
const patchAssignment = z.object(assignFields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const asDto = (r) => ({ id: r.id, title: r.title, description: r.description, dueAt: r.due_at, subjectId: r.subject_id, subject: r.subject_name ?? null, submitted: r.submitted ?? 0, total: r.total ?? 0 });

async function checkSubject(db, classId, subjectId) {
  if (!subjectId) return;
  const s = (await db.query('SELECT 1 FROM subjects WHERE id = $1 AND class_id = $2', [subjectId, classId])).rows[0];
  if (!s) throw badRequest('INVALID_SUBJECT', 'That subject does not belong to this class');
}

// GET /classes/:classId/assignments — deadline tracker with submission counts
router.get('/assignments', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, s.name AS subject_name,
            (SELECT count(*)::int FROM assignment_submissions x JOIN class_enrollments e ON e.student_id = x.student_id AND e.class_id = a.class_id AND e.status = 'approved'
              WHERE x.assignment_id = a.id AND x.submitted_at IS NOT NULL) AS submitted,
            (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = a.class_id AND e.status = 'approved') AS total
       FROM assignments a LEFT JOIN subjects s ON s.id = a.subject_id WHERE a.class_id = $1 ORDER BY a.due_at DESC`, [req.params.classId]);
  res.json({ assignments: rows.map(asDto) });
}));

// POST /classes/:classId/assignments
router.post('/assignments', validate({ body: createAssignment }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    await checkSubject(c, req.params.classId, b.subjectId);
    const r = (await c.query('INSERT INTO assignments (class_id, subject_id, title, description, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.classId, b.subjectId ?? null, b.title, b.description ?? null, b.dueAt, req.user.id])).rows[0];
    await notifyMany(c, await studentIds(c, req.params.classId), { type: 'assignment', title: `New assignment: ${b.title}`, body: `Due ${b.dueAt.toDateString()}`, link: '/student/planner' });
    await audit(c, { ...ctxOf(req), action: 'assignment.create', entityType: 'assignments', entityId: r.id, classId: req.params.classId });
    return r;
  });
  res.status(201).json({ assignment: asDto(row) });
}));

const asnParam = z.object({ classId: uuid, aid: uuid });
async function ownAssignment(db, classId, id) {
  const a = (await db.query('SELECT * FROM assignments WHERE id = $1 AND class_id = $2', [id, classId])).rows[0];
  if (!a) throw notFound('Assignment');
  return a;
}

// PATCH /classes/:classId/assignments/:aid
router.patch('/assignments/:aid', validate({ params: asnParam, body: patchAssignment }), asyncHandler(async (req, res) => {
  const b = req.body;
  const cur = await ownAssignment(pool, req.params.classId, req.params.aid);
  await checkSubject(pool, req.params.classId, b.subjectId);
  const { rows } = await pool.query(
    `UPDATE assignments SET title = COALESCE($2, title), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
            due_at = COALESCE($5, due_at), subject_id = CASE WHEN $6::boolean THEN $7::uuid ELSE subject_id END WHERE id = $1 RETURNING *`,
    [cur.id, b.title ?? null, 'description' in b, b.description ?? null, b.dueAt ?? null, 'subjectId' in b, b.subjectId ?? null]);
  res.json({ assignment: asDto(rows[0]) });
}));

// DELETE /classes/:classId/assignments/:aid
router.delete('/assignments/:aid', validate({ params: asnParam }), asyncHandler(async (req, res) => {
  const cur = await ownAssignment(pool, req.params.classId, req.params.aid);
  await pool.query('DELETE FROM assignments WHERE id = $1', [cur.id]);
  await audit(pool, { ...ctxOf(req), action: 'assignment.delete', entityType: 'assignments', entityId: cur.id, classId: req.params.classId });
  res.status(204).end();
}));

// GET /classes/:classId/assignments/:aid/submissions — who has / hasn't submitted
router.get('/assignments/:aid/submissions', validate({ params: asnParam }), asyncHandler(async (req, res) => {
  const a = await ownAssignment(pool, req.params.classId, req.params.aid);
  const { rows } = await pool.query(
    `SELECT e.student_id, u.full_name, e.roll_number, s.submitted_at, s.grade_remarks FROM class_enrollments e JOIN users u ON u.id = e.student_id
       LEFT JOIN assignment_submissions s ON s.assignment_id = $2 AND s.student_id = e.student_id
      WHERE e.class_id = $1 AND e.status = 'approved' ORDER BY (s.submitted_at IS NULL), e.roll_number NULLS LAST, u.full_name`, [req.params.classId, a.id]);
  res.json({ assignment: asDto(a), submissions: rows.map((r) => ({ studentId: r.student_id, name: r.full_name, rollNumber: r.roll_number, submittedAt: r.submitted_at, late: r.submitted_at ? new Date(r.submitted_at) > new Date(a.due_at) : null, remarks: r.grade_remarks })) });
}));

// PUT /classes/:classId/assignments/:aid/submissions/:sid  { remarks }
router.put('/assignments/:aid/submissions/:sid', validate({ params: z.object({ classId: uuid, aid: uuid, sid: uuid }), body: z.object({ remarks: text(1, 500) }) }), asyncHandler(async (req, res) => {
  const a = await ownAssignment(pool, req.params.classId, req.params.aid);
  const ok = (await pool.query(`SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2 AND status = 'approved'`, [req.params.classId, req.params.sid])).rows[0];
  if (!ok) throw notFound('Student');
  await pool.query(
    `INSERT INTO assignment_submissions (assignment_id, student_id, grade_remarks) VALUES ($1,$2,$3)
     ON CONFLICT (assignment_id, student_id) DO UPDATE SET grade_remarks = EXCLUDED.grade_remarks`, [a.id, req.params.sid, req.body.remarks]);
  res.json({ saved: true });
}));

// ================================================================ mentoring notes
const stuParam = z.object({ classId: uuid, sid: uuid });
async function approvedStudent(db, classId, sid) {
  const ok = (await db.query(`SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2 AND status = 'approved'`, [classId, sid])).rows[0];
  if (!ok) throw notFound('Student');
}

// POST /classes/:classId/students/:sid/notes  { note, visibleToStudent? }   (read them in GET …/students/:sid)
router.post('/students/:sid/notes', validate({ params: stuParam, body: z.object({ note: text(2, 2000), visibleToStudent: z.boolean().default(false) }) }), asyncHandler(async (req, res) => {
  await approvedStudent(pool, req.params.classId, req.params.sid);
  const r = (await pool.query(
    'INSERT INTO mentoring_notes (class_id, student_id, instructor_id, note, visible_to_student) VALUES ($1,$2,$3,$4,$5) RETURNING id, note, visible_to_student, created_at',
    [req.params.classId, req.params.sid, req.user.id, req.body.note, req.body.visibleToStudent])).rows[0];
  res.status(201).json({ note: { id: r.id, note: r.note, visibleToStudent: r.visible_to_student, createdAt: r.created_at } });
}));

// DELETE /classes/:classId/students/:sid/notes/:nid
router.delete('/students/:sid/notes/:nid', validate({ params: z.object({ classId: uuid, sid: uuid, nid: uuid }) }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM mentoring_notes WHERE id = $1 AND class_id = $2 AND student_id = $3', [req.params.nid, req.params.classId, req.params.sid]);
  if (!rowCount) throw notFound('Note');
  res.status(204).end();
}));

// ================================================================ parent notifications (queued log; no SMS/e-mail provider yet)
// POST /classes/:classId/parent-notifications
router.post('/parent-notifications', validate({ body: z.object({
  studentIds: z.array(uuid).min(1).max(200), channel: z.enum(['email', 'sms']), reason: z.enum(['low_attendance', 'poor_marks', 'custom']), message: text(5, 600),
}) }), asyncHandler(async (req, res) => {
  const b = req.body;
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT e.student_id, u.full_name, p.guardian_name, p.guardian_email::text AS guardian_email, p.guardian_phone
         FROM class_enrollments e JOIN users u ON u.id = e.student_id LEFT JOIN student_profiles p ON p.user_id = e.student_id
        WHERE e.class_id = $1 AND e.status = 'approved' AND e.student_id = ANY($2::uuid[])`, [req.params.classId, b.studentIds]);
    if (rows.length !== new Set(b.studentIds).size) throw badRequest('INVALID_STUDENT', 'Some students are not approved members of this class');
    const results = [];
    for (const r of rows) {
      const contact = b.channel === 'email' ? r.guardian_email : r.guardian_phone;
      const status = contact ? 'queued' : 'failed';
      await c.query('INSERT INTO parent_notifications (student_id, channel, reason, message, status, sent_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [r.student_id, b.channel, b.reason, b.message, status, req.user.id]);
      if (contact && b.channel === 'email') await mailer.send({ to: contact, subject: `Message about ${r.full_name} from the class instructor`, text: b.message });
      results.push({ studentId: r.student_id, name: r.full_name, status, ...(contact ? {} : { problem: `No guardian ${b.channel === 'email' ? 'e-mail' : 'phone'} on file` }) });
    }
    await audit(c, { ...ctxOf(req), action: 'parent.notify', entityType: 'class', entityId: req.params.classId, classId: req.params.classId, metadata: { channel: b.channel, reason: b.reason, count: rows.length } });
    return results;
  });
  res.status(201).json({ queued: out.filter((r) => r.status === 'queued').length, failed: out.filter((r) => r.status === 'failed').length, results: out });
}));

// GET /classes/:classId/parent-notifications
router.get('/parent-notifications', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.id, n.channel, n.reason, n.message, n.status, n.created_at, u.full_name FROM parent_notifications n JOIN users u ON u.id = n.student_id
       JOIN class_enrollments e ON e.student_id = n.student_id AND e.class_id = $1 AND e.status = 'approved' ORDER BY n.created_at DESC LIMIT 100`, [req.params.classId]);
  res.json({ notifications: rows.map((r) => ({ id: r.id, student: r.full_name, channel: r.channel, reason: r.reason, message: r.message, status: r.status, createdAt: r.created_at })) });
}));

// ================================================================ audit log
// GET /classes/:classId/audit-logs?limit=50&before=<id>&action=marks
router.get('/audit-logs', validate({ query: z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().positive().optional(), action: z.string().trim().max(40).optional(),
}) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const like = q.action ? `${q.action.replace(/[%_\\]/g, '\\$&')}%` : null;
  const { rows } = await pool.query(
    `SELECT l.id, l.action, l.entity_type, l.entity_id, l.actor_role, l.metadata, l.created_at, u.full_name AS actor
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.class_id = $1 AND ($2::bigint IS NULL OR l.id < $2) AND ($3::text IS NULL OR l.action LIKE $3) ORDER BY l.id DESC LIMIT $4`,
    [req.params.classId, q.before ?? null, like, q.limit + 1]);
  const page = rows.slice(0, q.limit);
  res.json({
    logs: page.map((r) => ({ id: Number(r.id), action: r.action, entityType: r.entity_type, entityId: r.entity_id, actor: r.actor, actorRole: r.actor_role, metadata: r.metadata, at: r.created_at })),
    nextBefore: rows.length > q.limit ? Number(page[page.length - 1].id) : null,
  });
}));

module.exports = router;
