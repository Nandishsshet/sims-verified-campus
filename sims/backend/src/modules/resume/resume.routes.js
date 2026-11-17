'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { AppError, asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { validate } = require('../../middleware/validate');
const { scoreResume } = require('../../services/ats');
const resumeAi = require('../../services/resumeAi');
const { approvedStudentOnly, idParam } = require('../student/student.common');
const { SECTIONS, DEFAULT_ORDER, TEMPLATES, buildResumeData, mergeContent } = require('./resumeData');

router.use(...approvedStudentOnly);

const MAX_RESUMES = 5;
const templateKey = z.enum(TEMPLATES.map((t) => t.key));
const contentSchema = z.object({
  summary: z.string().trim().max(800).optional(),
  contact: z.object({
    location: z.string().trim().max(120).nullable().optional(), phone: z.string().trim().max(20).nullable().optional(),
    linkedin: z.string().trim().url().max(200).nullable().optional(), github: z.string().trim().url().max(200).nullable().optional(),
  }).optional(),
  extraSkills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  bullets: z.record(z.string().uuid(), z.array(z.string().trim().min(3).max(300)).max(8)).optional(),
  hidden: z.array(z.string().min(1).max(60)).max(100).optional(),
}).strict();
const sectionOrder = z.array(z.enum(SECTIONS)).min(1).refine((a) => new Set(a).size === a.length, 'Duplicate sections');

const createBody = z.object({ title: z.string().trim().min(1).max(80).default('My Resume'), templateKey: templateKey.default('classic'), targetRoleId: z.string().uuid().nullable().optional() });
const updateBody = z.object({ title: z.string().trim().min(1).max(80), templateKey, targetRoleId: z.string().uuid().nullable(), sectionOrder, content: contentSchema })
  .partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

async function roleKeywords(roleId) {
  if (!roleId) return { name: null, keywords: [] };
  const role = (await pool.query('SELECT name FROM career_roles WHERE id = $1', [roleId])).rows[0];
  const kw = (await pool.query('SELECT s.name FROM role_skills rs JOIN skills s ON s.id = rs.skill_id WHERE rs.role_id = $1 ORDER BY rs.weight DESC', [roleId])).rows.map((r) => r.name);
  return { name: role?.name ?? null, keywords: kw };
}

/** Build merged data + ATS report for a resume row (always from live verified data). */
async function assemble(studentId, resume) {
  const { data, facts } = await buildResumeData(studentId);
  const merged = mergeContent(data, resume.content);
  const role = await roleKeywords(resume.target_role_id);
  const ats = scoreResume({ data: merged, roleKeywords: role.keywords, templateKey: resume.template_key });
  return { base: data, merged, facts: { ...facts, targetRole: role.name }, ats, roleName: role.name };
}

const dto = (r) => ({
  id: r.id, title: r.title, templateKey: r.template_key, targetRoleId: r.target_role_id, sectionOrder: r.section_order,
  content: r.content || {}, atsScore: r.ats_score, updatedAt: r.updated_at,
});

async function ownResume(id, studentId) {
  const r = (await pool.query('SELECT * FROM resumes WHERE id = $1 AND student_id = $2', [id, studentId])).rows[0];
  if (!r) throw notFound('Resume');
  return r;
}

// GET /student/resumes/templates   (declared before /:id)
router.get('/templates', (req, res) => res.json({ templates: TEMPLATES, sections: SECTIONS }));

// GET /student/resumes
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM resumes WHERE student_id = $1 ORDER BY updated_at DESC', [req.user.id]);
  res.json({ resumes: rows.map(dto), max: MAX_RESUMES });
}));

// POST /student/resumes — auto-filled from verified data
router.post('/', validate({ body: createBody }), asyncHandler(async (req, res) => {
  const count = (await pool.query('SELECT count(*)::int AS n FROM resumes WHERE student_id = $1', [req.user.id])).rows[0].n;
  if (count >= MAX_RESUMES) throw new AppError(409, 'RESUME_LIMIT', `You can keep up to ${MAX_RESUMES} resumes`);
  const target = req.body.targetRoleId ?? (await pool.query('SELECT role_id FROM student_target_roles WHERE student_id = $1', [req.user.id])).rows[0]?.role_id ?? null;
  const row = (await pool.query(
    `INSERT INTO resumes (student_id, title, template_key, target_role_id, section_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.id, req.body.title, req.body.templateKey, target, DEFAULT_ORDER])).rows[0];
  const { ats } = await assemble(req.user.id, row);
  const saved = (await pool.query('UPDATE resumes SET ats_score = $2, ats_report = $3 WHERE id = $1 RETURNING *', [row.id, ats.score, JSON.stringify(ats)])).rows[0];
  res.status(201).json({ resume: dto(saved) });
}));

// GET /student/resumes/:id — the resume + merged data for live preview + ATS report
router.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const row = await ownResume(req.params.id, req.user.id);
  const { base, merged, ats } = await assemble(req.user.id, row);
  if (row.ats_score !== ats.score) await pool.query('UPDATE resumes SET ats_score = $2, ats_report = $3 WHERE id = $1', [row.id, ats.score, JSON.stringify(ats)]);
  // `base` = verified auto-fill without the student's edits, so the editor can re-apply edits live (e.g. un-hide an item)
  res.json({ resume: { ...dto(row), atsScore: ats.score }, data: merged, base, ats });
}));

// PUT /student/resumes/:id — partial update (title, template, role, section order, content)
router.put('/:id', validate({ params: idParam, body: updateBody }), asyncHandler(async (req, res) => {
  const row = await ownResume(req.params.id, req.user.id);
  const b = req.body;
  if (b.targetRoleId) {
    const ok = await pool.query('SELECT 1 FROM career_roles WHERE id = $1 AND is_active', [b.targetRoleId]);
    if (!ok.rowCount) throw badRequest('INVALID_ROLE', 'Unknown role');
  }
  const next = {
    ...row,
    title: b.title ?? row.title, template_key: b.templateKey ?? row.template_key,
    target_role_id: 'targetRoleId' in b ? b.targetRoleId : row.target_role_id,
    section_order: b.sectionOrder ?? row.section_order,
    content: b.content ? { ...(row.content || {}), ...b.content } : row.content,
  };
  const { merged, ats } = await assemble(req.user.id, next);
  const saved = (await pool.query(
    `UPDATE resumes SET title = $2, template_key = $3, target_role_id = $4, section_order = $5, content = $6, ats_score = $7, ats_report = $8
      WHERE id = $1 RETURNING *`,
    [row.id, next.title, next.template_key, next.target_role_id, next.section_order, JSON.stringify(next.content ?? {}), ats.score, JSON.stringify(ats)])).rows[0];
  res.json({ resume: dto(saved), data: merged, ats });
}));

// DELETE /student/resumes/:id
router.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM resumes WHERE id = $1 AND student_id = $2', [req.params.id, req.user.id]);
  if (!rowCount) throw notFound('Resume');
  res.status(204).end();
}));

// GET /student/resumes/:id/ats
router.get('/:id/ats', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const row = await ownResume(req.params.id, req.user.id);
  res.json({ ats: (await assemble(req.user.id, row)).ats });
}));

// POST /student/resumes/:id/ai/improve  { section: 'summary' | 'bullet', text }
router.post('/:id/ai/improve', validate({ params: idParam, body: z.object({ section: z.enum(['summary', 'bullet']), text: z.string().trim().max(600).default('') }).refine((v) => v.section === 'summary' || v.text.length > 0, { path: ['text'], message: 'Text is required for a bullet' }) }),
asyncHandler(async (req, res) => {
  const row = await ownResume(req.params.id, req.user.id);
  const { facts } = await assemble(req.user.id, row);
  res.json(await resumeAi.improve({ section: req.body.section, text: req.body.text, ctx: facts }));
}));

module.exports = router;
