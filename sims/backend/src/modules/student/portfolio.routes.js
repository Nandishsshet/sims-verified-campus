'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { validate } = require('../../middleware/validate');
const { approvedStudentOnly, submitForVerification, withdrawRequests, setEvidenceSkills, idParam, skillLinks } = require('./student.common');

router.use(...approvedStudentOnly);

const TYPES = ['project', 'internship', 'publication'];
const text = (max) => z.string().trim().max(max);
// Field shapes carry no defaults, so a PATCH never silently resets omitted lists; create adds them back.
const fields = {
  title: z.string().trim().min(2).max(200),
  organization: text(200).nullable().optional(),
  role: text(120).nullable().optional(),
  description: text(1000).nullable().optional(),
  bullets: z.array(z.string().trim().min(3).max(300)).max(8),
  techStack: z.array(z.string().trim().min(1).max(40)).max(15),
  url: z.string().trim().url().max(300).refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link').nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  skills: skillLinks,
};
const dateOrder = (v) => !v.startDate || !v.endDate || v.endDate >= v.startDate;
const dateRule = { path: ['endDate'], message: 'End date must not be before the start date' };
const createBody = z.object({
  ...fields,
  type: z.enum(TYPES),
  bullets: fields.bullets.default([]),
  techStack: fields.techStack.default([]),
  skills: fields.skills.default([]),
}).refine(dateOrder, dateRule);
const patchBody = z.object(fields).partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .refine(dateOrder, dateRule);

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);   // works for 'YYYY-MM-DD' strings (DB) and Dates (parsed input)
const dto = (r, skills = []) => ({
  id: r.id, type: r.type, title: r.title, organization: r.organization, role: r.role, description: r.description,
  bullets: r.bullets, techStack: r.tech_stack, url: r.url, startDate: r.start_date, endDate: r.end_date,
  status: r.verification_status, remarks: r.verifier_remarks, verifiedAt: r.verified_at, skills,
});

async function assertSkillsExist(skills) {
  if (!skills.length) return;
  const ids = [...new Set(skills.map((s) => s.skillId))];
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM skills WHERE id = ANY($1::uuid[])', [ids]);
  if (rows[0].n !== ids.length) throw badRequest('INVALID_SKILL', 'One of the selected skills does not exist');
}

async function skillsFor(ids) {
  const m = new Map();
  if (!ids.length) return m;
  const { rows } = await pool.query(
    `SELECT ss.portfolio_id, ss.skill_id, ss.proficiency, s.name FROM student_skills ss JOIN skills s ON s.id = ss.skill_id WHERE ss.portfolio_id = ANY($1::uuid[])`, [ids]);
  for (const r of rows) { if (!m.has(r.portfolio_id)) m.set(r.portfolio_id, []); m.get(r.portfolio_id).push({ skillId: r.skill_id, name: r.name, proficiency: r.proficiency }); }
  return m;
}

// GET /student/portfolio?type=project
router.get('/', validate({ query: z.object({ type: z.enum(TYPES).optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM portfolio_items WHERE student_id = $1 AND ($2::text IS NULL OR type::text = $2)
      ORDER BY COALESCE(end_date, start_date, created_at::date) DESC, created_at DESC`, [req.user.id, req.query.type ?? null]);
  const sk = await skillsFor(rows.map((r) => r.id));
  res.json({ items: rows.map((r) => dto(r, sk.get(r.id) || [])) });
}));

// POST /student/portfolio
router.post('/', validate({ body: createBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  await assertSkillsExist(b.skills);
  const row = await tx(async (c) => {
    const ins = (await c.query(
      `INSERT INTO portfolio_items (student_id, type, title, organization, role, description, bullets, tech_stack, url, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.id, b.type, b.title, b.organization ?? null, b.role ?? null, b.description ?? null, b.bullets, b.techStack, b.url ?? null, day(b.startDate), day(b.endDate)])).rows[0];
    await setEvidenceSkills(c, req.user.id, 'portfolio_id', ins.id, b.skills);
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'project', entityId: ins.id });
    return ins;
  });
  res.status(201).json({ item: dto(row, b.skills) });
}));

// PATCH /student/portfolio/:id — edits go back to the instructor
router.patch('/:id', validate({ params: idParam, body: patchBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  if (b.skills) await assertSkillsExist(b.skills);
  const row = await tx(async (c) => {
    const map = { title: 'title', organization: 'organization', role: 'role', description: 'description', bullets: 'bullets', techStack: 'tech_stack', url: 'url', startDate: 'start_date', endDate: 'end_date' };
    const sets = []; const vals = [req.params.id, req.user.id];
    for (const [k, col] of Object.entries(map)) if (k in b) { vals.push(k.endsWith('Date') ? day(b[k]) : b[k]); sets.push(`${col} = $${vals.length}`); }
    sets.push(`verification_status = 'pending'`, 'verified_by = NULL', 'verified_at = NULL', 'verifier_remarks = NULL');
    const upd = (await c.query(`UPDATE portfolio_items SET ${sets.join(', ')} WHERE id = $1 AND student_id = $2 RETURNING *`, vals)).rows[0];
    if (!upd) throw notFound('Item');
    if (b.skills) await setEvidenceSkills(c, req.user.id, 'portfolio_id', upd.id, b.skills);
    await submitForVerification(c, { studentId: req.user.id, classId: req.scope.classId, entityType: 'project', entityId: upd.id });
    return upd;
  });
  res.json({ item: dto(row, (await skillsFor([row.id])).get(row.id) || []) });
}));

// DELETE /student/portfolio/:id
router.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query('DELETE FROM portfolio_items WHERE id = $1 AND student_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (!rows[0]) throw notFound('Item');
    await withdrawRequests(c, 'project', rows[0].id);
  });
  res.status(204).end();
}));

module.exports = router;
