'use strict';
/**
 * Class setup — /classes/:classId/{subjects,timetable} and PATCH /classes/:classId.
 * Subjects are the backbone of attendance and marks, so deleting one that already has data is refused.
 */
const { z } = require('zod');
const router = require('express').Router({ mergeParams: true });
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { validate } = require('../../middleware/validate');

const uuid = z.string().uuid();
const subjectFields = {
  semester: z.number().int().min(1).max(12),
  code: z.string().trim().toUpperCase().min(2).max(20),
  name: z.string().trim().min(2).max(120),
  credits: z.number().min(0).max(30).multipleOf(0.5),
  isLab: z.boolean(),
};
const createSubject = z.object({ ...subjectFields, isLab: subjectFields.isLab.default(false) });
const patchSubject = z.object(subjectFields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const dto = (r) => ({ id: r.id, semester: r.semester, code: r.code, name: r.name, credits: Number(r.credits), isLab: r.is_lab });

// GET /classes/:classId/subjects?semester=
router.get('/subjects', validate({ query: z.object({ semester: z.coerce.number().int().min(1).max(12).optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM subjects WHERE class_id = $1 AND ($2::int IS NULL OR semester = $2) ORDER BY semester, code', [req.params.classId, req.query.semester ?? null]);
  res.json({ subjects: rows.map(dto) });
}));

// POST /classes/:classId/subjects   (duplicate semester+code → 409 CONFLICT)
router.post('/subjects', validate({ body: createSubject }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    const r = (await c.query('INSERT INTO subjects (class_id, semester, code, name, credits, is_lab) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.classId, b.semester, b.code, b.name, b.credits, b.isLab])).rows[0];
    await audit(c, { ...ctxOf(req), action: 'subject.create', entityType: 'subjects', entityId: r.id, classId: req.params.classId });
    return r;
  });
  res.status(201).json({ subject: dto(row) });
}));

// PATCH /classes/:classId/subjects/:sid — moving a subject to another semester is refused once it has marks
router.patch('/subjects/:sid', validate({ params: z.object({ classId: uuid, sid: uuid }), body: patchSubject }), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM subjects WHERE id = $1 AND class_id = $2 FOR UPDATE', [req.params.sid, req.params.classId])).rows[0];
    if (!cur) throw notFound('Subject');
    if (b.semester != null && b.semester !== cur.semester) {
      const used = (await c.query('SELECT (SELECT count(*) FROM marks WHERE subject_id = $1) + (SELECT count(*) FROM attendance_records WHERE subject_id = $1) AS n', [cur.id])).rows[0].n;
      if (Number(used) > 0) throw new AppError(409, 'SUBJECT_IN_USE', 'This subject already has marks or attendance, so it cannot move to another semester');
    }
    const r = (await c.query(
      `UPDATE subjects SET semester = COALESCE($2, semester), code = COALESCE($3, code), name = COALESCE($4, name),
              credits = COALESCE($5, credits), is_lab = COALESCE($6, is_lab) WHERE id = $1 RETURNING *`,
      [cur.id, b.semester ?? null, b.code ?? null, b.name ?? null, b.credits ?? null, b.isLab ?? null])).rows[0];
    // marks.semester is denormalised for speed — it only changes with the semester, which is blocked above once marks exist
    await audit(c, { ...ctxOf(req), action: 'subject.update', entityType: 'subjects', entityId: cur.id, classId: req.params.classId, metadata: b });
    return r;
  });
  res.json({ subject: dto(row) });
}));

// DELETE /classes/:classId/subjects/:sid — only while nothing refers to it (cascades would silently erase marks / attendance)
router.delete('/subjects/:sid', validate({ params: z.object({ classId: uuid, sid: uuid }) }), asyncHandler(async (req, res) => {
  await tx(async (c) => {
    const cur = (await c.query('SELECT id FROM subjects WHERE id = $1 AND class_id = $2 FOR UPDATE', [req.params.sid, req.params.classId])).rows[0];
    if (!cur) throw notFound('Subject');
    const used = (await c.query('SELECT (SELECT count(*) FROM marks WHERE subject_id = $1) + (SELECT count(*) FROM attendance_records WHERE subject_id = $1) AS n', [cur.id])).rows[0].n;
    if (Number(used) > 0) throw new AppError(409, 'SUBJECT_IN_USE', 'This subject already has marks or attendance and cannot be deleted');
    await c.query('DELETE FROM subjects WHERE id = $1', [cur.id]);
    await audit(c, { ...ctxOf(req), action: 'subject.delete', entityType: 'subjects', entityId: cur.id, classId: req.params.classId });
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------- class settings
const patchClass = z.object({
  name: z.string().trim().min(2).max(120),
  currentSemester: z.number().int().min(1).max(12),
  hodName: z.string().trim().max(120).nullable(),
  instructorName: z.string().trim().min(2).max(120),
  instructorPhone: z.string().trim().max(30).nullable(),
  instructorEmail: z.string().trim().toLowerCase().email().nullable(),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// PATCH /classes/:classId
router.patch('/', validate({ body: patchClass }), asyncHandler(async (req, res) => {
  const b = req.body;
  const map = { name: 'name', currentSemester: 'current_semester', hodName: 'hod_name', instructorName: 'instructor_name', instructorPhone: 'instructor_phone', instructorEmail: 'instructor_email' };
  const sets = ['updated_at = now()']; const vals = [req.params.classId];
  for (const [k, col] of Object.entries(map)) if (k in b) { vals.push(b[k]); sets.push(`${col} = $${vals.length}`); }     // column names come from the fixed map
  const row = await tx(async (c) => {
    const r = (await c.query(`UPDATE classes SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, current_semester, hod_name, instructor_name, instructor_phone, instructor_email`, vals)).rows[0];
    await audit(c, { ...ctxOf(req), action: 'class.update', entityType: 'class', entityId: r.id, classId: r.id, metadata: b });
    return r;
  });
  res.json({ class: { id: row.id, name: row.name, currentSemester: row.current_semester, hodName: row.hod_name, instructorName: row.instructor_name, instructorPhone: row.instructor_phone, instructorEmail: row.instructor_email } });
}));

// ---------------------------------------------------------------- timetable
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const slot = z.object({ subjectId: uuid, dayOfWeek: z.number().int().min(1).max(7), startsAt: time, endsAt: time, room: z.string().trim().max(40).nullable().optional() })
  .refine((s) => s.endsAt > s.startsAt, { path: ['endsAt'], message: 'End time must be after the start time' });

// GET /classes/:classId/timetable
router.get('/timetable', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.subject_id, s.code, s.name, t.day_of_week, to_char(t.starts_at, 'HH24:MI') AS starts_at, to_char(t.ends_at, 'HH24:MI') AS ends_at, t.room
       FROM timetable_entries t JOIN subjects s ON s.id = t.subject_id WHERE t.class_id = $1 ORDER BY t.day_of_week, t.starts_at`, [req.params.classId]);
  res.json({ slots: rows.map((r) => ({ id: r.id, subjectId: r.subject_id, code: r.code, subject: r.name, dayOfWeek: r.day_of_week, startsAt: r.starts_at, endsAt: r.ends_at, room: r.room })) });
}));

// PUT /classes/:classId/timetable — replaces the whole weekly timetable atomically
router.put('/timetable', validate({ body: z.object({ slots: z.array(slot).max(100) }) }), asyncHandler(async (req, res) => {
  const { slots } = req.body;
  // two lessons of the SAME class cannot overlap on a day
  const byDay = new Map();
  for (const s of slots) { if (!byDay.has(s.dayOfWeek)) byDay.set(s.dayOfWeek, []); byDay.get(s.dayOfWeek).push(s); }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < list.length; i += 1) if (list[i].startsAt < list[i - 1].endsAt) throw badRequest('TIMETABLE_OVERLAP', `Lessons overlap on day ${list[i].dayOfWeek} (${list[i - 1].startsAt}–${list[i - 1].endsAt} and ${list[i].startsAt}–${list[i].endsAt})`);
  }
  await tx(async (c) => {
    const ids = [...new Set(slots.map((s) => s.subjectId))];
    const ok = ids.length ? (await c.query('SELECT count(*)::int AS n FROM subjects WHERE class_id = $1 AND id = ANY($2::uuid[])', [req.params.classId, ids])).rows[0].n : 0;
    if (ok !== ids.length) throw badRequest('INVALID_SUBJECT', 'A subject in the timetable does not belong to this class');
    await c.query('DELETE FROM timetable_entries WHERE class_id = $1', [req.params.classId]);
    for (const s of slots) {
      await c.query('INSERT INTO timetable_entries (class_id, subject_id, day_of_week, starts_at, ends_at, room) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.params.classId, s.subjectId, s.dayOfWeek, s.startsAt, s.endsAt, s.room ?? null]);
    }
    await audit(c, { ...ctxOf(req), action: 'timetable.replace', entityType: 'class', entityId: req.params.classId, classId: req.params.classId, metadata: { slots: slots.length } });
  });
  res.json({ saved: slots.length });
}));

module.exports = router;
