'use strict';
/**
 * University head: profile and university-wide announcements. Mounted at /university.
 * (College approve / suspend / reinstate live in universities.routes.js.)
 */
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { asyncHandler, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notifyMany } = require('../../utils/notify');
const { validate } = require('../../middleware/validate');

const uuid = z.string().uuid();
const text = (min, max) => z.string().trim().min(min).max(max);
const idParam = z.object({ id: uuid });

// ================================================================ profile
const patchUniversity = z.object({
  name: text(2, 160), headTitle: text(2, 60), headName: text(2, 120),
  address: z.string().trim().max(300).nullable(), contactEmail: z.string().trim().toLowerCase().email().nullable(), contactPhone: z.string().trim().max(30).nullable(),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// PATCH /university
router.patch('/', validate({ body: patchUniversity }), asyncHandler(async (req, res) => {
  const map = { name: 'name', headTitle: 'head_title', headName: 'head_name', address: 'address', contactEmail: 'contact_email', contactPhone: 'contact_phone' };
  const sets = ['updated_at = now()']; const vals = [req.scope.universityId];
  for (const [k, col] of Object.entries(map)) if (k in req.body) { vals.push(req.body[k]); sets.push(`${col} = $${vals.length}`); }   // column names come from the fixed map
  const row = await tx(async (c) => {
    const r = (await c.query(`UPDATE universities SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, head_title, head_name, address, contact_email, contact_phone, status`, vals)).rows[0];
    if (!r) throw notFound('University');
    await audit(c, { ...ctxOf(req), action: 'university.update', entityType: 'university', entityId: r.id, metadata: req.body });
    return r;
  });
  res.json({ university: row });
}));

// ================================================================ announcements (broadcast to the whole university)
/** Everyone the broadcast reaches, by kind: college admins (any status), approved instructors, approved students of active classes. */
async function audience(db, universityId) {
  const [admins, instructors, students] = await Promise.all([
    db.query('SELECT admin_user_id AS id FROM colleges WHERE university_id = $1', [universityId]),
    db.query(`SELECT DISTINCT ci.user_id AS id FROM college_instructors ci JOIN colleges c ON c.id = ci.college_id WHERE c.university_id = $1 AND ci.status = 'approved'`, [universityId]),
    db.query(
      `SELECT DISTINCT e.student_id AS id FROM class_enrollments e JOIN classes c ON c.id = e.class_id JOIN colleges col ON col.id = c.college_id
        WHERE col.university_id = $1 AND e.status = 'approved' AND c.status = 'active'`, [universityId]),
  ]);
  return { admins: admins.rows.map((r) => r.id), instructors: instructors.rows.map((r) => r.id), students: students.rows.map((r) => r.id) };
}

// GET /university/announcements
router.get('/announcements', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.body, a.is_pinned, a.created_at, u.full_name AS author FROM announcements a JOIN users u ON u.id = a.author_id
      WHERE a.university_id = $1 ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT 100`, [req.scope.universityId]);
  res.json({ announcements: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, pinned: r.is_pinned, createdAt: r.created_at, author: r.author })) });
}));

// POST /university/announcements — shown on every student's dashboard; college admins, instructors and students are notified
router.post('/announcements', validate({ body: z.object({ title: text(2, 150), body: text(2, 2000), pinned: z.boolean().default(false) }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  const out = await tx(async (c) => {
    const a = (await c.query(
      `INSERT INTO announcements (scope, university_id, title, body, is_pinned, author_id) VALUES ('university',$1,$2,$3,$4,$5) RETURNING id, title, body, is_pinned, created_at`,
      [req.scope.universityId, b.title, b.body, b.pinned, req.user.id])).rows[0];
    const aud = await audience(c, req.scope.universityId);
    const note = { type: 'announcement', title: b.title, body: b.body.slice(0, 200) };
    await notifyMany(c, aud.admins, { ...note, link: '/college' });
    await notifyMany(c, aud.instructors, { ...note, link: '/class' });
    await notifyMany(c, aud.students, { ...note, link: '/student/activities' });
    const recipients = aud.admins.length + aud.instructors.length + aud.students.length;
    await audit(c, { ...ctxOf(req), action: 'announcement.create', entityType: 'announcements', entityId: a.id, metadata: { scope: 'university', recipients } });
    return { a, recipients, breakdown: { collegeAdmins: aud.admins.length, instructors: aud.instructors.length, students: aud.students.length } };
  });
  res.status(201).json({ announcement: { id: out.a.id, title: out.a.title, body: out.a.body, pinned: out.a.is_pinned, createdAt: out.a.created_at }, recipients: out.recipients, breakdown: out.breakdown });
}));

router.patch('/announcements/:id', validate({ params: idParam, body: z.object({ pinned: z.boolean() }) }), asyncHandler(async (req, res) => {
  const { rows } = await pool.query('UPDATE announcements SET is_pinned = $3 WHERE id = $1 AND university_id = $2 RETURNING id, is_pinned', [req.params.id, req.scope.universityId, req.body.pinned]);
  if (!rows[0]) throw notFound('Announcement');
  res.json({ id: rows[0].id, pinned: rows[0].is_pinned });
}));

router.delete('/announcements/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM announcements WHERE id = $1 AND university_id = $2', [req.params.id, req.scope.universityId]);
  if (!rowCount) throw notFound('Announcement');
  await audit(pool, { ...ctxOf(req), action: 'announcement.delete', entityType: 'announcements', entityId: req.params.id });
  res.status(204).end();
}));

module.exports = router;
