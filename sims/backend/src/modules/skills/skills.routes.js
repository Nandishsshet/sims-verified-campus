'use strict';
/**
 * Skills, career roles and the SKILL GAP ANALYZER.
 *   catalogue   GET /skills, GET /career-roles[/:id]             (any signed-in user)
 *   student     /student/skills, /student/target-role, /student/skill-gap[/roadmap|/history]
 *
 * Two gap numbers are produced (docs/ARCHITECTURE.md §10.1):
 *   gapPct          — verified evidence + the student's self-declared skills (personal view)
 *   verifiedGapPct  — verified evidence only (what leaderboards and class analytics use)
 */
const { z } = require('zod');
const catalog = require('express').Router();
const student = require('express').Router();
const { pool } = require('../../db/pool');
const { asyncHandler, badRequest, notFound } = require('../../utils/errors');
const { protect } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const scoring = require('../../services/scoring');
const { buildRoadmap } = require('../../services/roadmap');
const { studentOnly, approvedStudentOnly, idParam } = require('../student/student.common');

// ----------------------------------------------------------------------------- catalogue
catalog.get('/skills', ...protect, validate({ query: z.object({ q: z.string().trim().max(60).optional() }) }), asyncHandler(async (req, res) => {
  const like = req.query.q ? `%${req.query.q.replace(/[%_\\]/g, '\\$&')}%` : null;
  const { rows } = await pool.query(
    `SELECT id, name, category FROM skills WHERE ($1::text IS NULL OR name ILIKE $1) ORDER BY category NULLS LAST, name LIMIT 300`, [like]);
  res.json({ skills: rows });
}));

catalog.get('/career-roles', ...protect, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.description, count(rs.skill_id)::int AS skill_count
       FROM career_roles r LEFT JOIN role_skills rs ON rs.role_id = r.id WHERE r.is_active GROUP BY r.id ORDER BY r.name`);
  res.json({ roles: rows });
}));

catalog.get('/career-roles/:id', ...protect, validate({ params: idParam }), asyncHandler(async (req, res) => {
  const role = (await pool.query('SELECT id, name, description FROM career_roles WHERE id = $1 AND is_active', [req.params.id])).rows[0];
  if (!role) throw notFound('Role');
  const { rows } = await pool.query(
    `SELECT s.id AS skill_id, s.name, s.category, rs.required_level, rs.weight FROM role_skills rs JOIN skills s ON s.id = rs.skill_id
      WHERE rs.role_id = $1 ORDER BY rs.weight DESC, s.name`, [role.id]);
  res.json({ role, requirements: rows.map((r) => ({ skillId: r.skill_id, name: r.name, category: r.category, requiredLevel: r.required_level, weight: Number(r.weight) })) });
}));

// ----------------------------------------------------------------------------- owned skills
/** Every skill the student has, with where it comes from and whether that evidence is verified. */
async function loadOwned(studentId) {
  const { rows } = await pool.query(
    `SELECT ss.id, ss.skill_id, s.name, s.category, ss.proficiency, ss.source, ss.certificate_id, ss.portfolio_id,
            c.title AS cert_title, p.title AS project_title,
            COALESCE(CASE ss.source WHEN 'manual' THEN ss.verification_status = 'verified'
                                    WHEN 'certificate' THEN c.verification_status = 'verified'
                                    ELSE p.verification_status = 'verified' END, false) AS verified
       FROM student_skills ss JOIN skills s ON s.id = ss.skill_id
       LEFT JOIN certificates c ON c.id = ss.certificate_id
       LEFT JOIN portfolio_items p ON p.id = ss.portfolio_id
      WHERE ss.student_id = $1 ORDER BY s.name, ss.source`, [studentId]);
  return rows;
}

student.get('/skills', ...studentOnly, asyncHandler(async (req, res) => {
  const rows = await loadOwned(req.user.id);
  res.json({ skills: rows.map((r) => ({
    id: r.id, skillId: r.skill_id, name: r.name, category: r.category, proficiency: r.proficiency, source: r.source,
    evidence: r.cert_title || r.project_title || null, verified: r.verified, selfDeclared: r.source === 'manual' && !r.verified,
  })) });
}));

const manualBody = z.object({ skillId: z.string().uuid(), proficiency: z.number().int().min(1).max(5) });

student.post('/skills', ...studentOnly, validate({ body: manualBody }), asyncHandler(async (req, res) => {
  const exists = await pool.query('SELECT 1 FROM skills WHERE id = $1', [req.body.skillId]);
  if (!exists.rowCount) throw badRequest('INVALID_SKILL', 'Unknown skill');
  const { rows } = await pool.query(
    `INSERT INTO student_skills (student_id, skill_id, proficiency, source) VALUES ($1,$2,$3,'manual') RETURNING id, skill_id, proficiency`,
    [req.user.id, req.body.skillId, req.body.proficiency]);                       // duplicate → 409 SKILL_EXISTS
  res.status(201).json({ skill: rows[0] });
}));

student.patch('/skills/:id', ...studentOnly, validate({ params: idParam, body: z.object({ proficiency: z.number().int().min(1).max(5) }) }), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE student_skills SET proficiency = $3 WHERE id = $1 AND student_id = $2 AND source = 'manual' RETURNING id, skill_id, proficiency`,
    [req.params.id, req.user.id, req.body.proficiency]);
  if (!rows[0]) throw notFound('Skill');
  res.json({ skill: rows[0] });
}));

student.delete('/skills/:id', ...studentOnly, validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM student_skills WHERE id = $1 AND student_id = $2 AND source = 'manual'`, [req.params.id, req.user.id]);
  if (!rowCount) throw notFound('Skill');
  res.status(204).end();
}));

// ----------------------------------------------------------------------------- target role
student.get('/target-role', ...studentOnly, asyncHandler(async (req, res) => {
  const r = (await pool.query(
    `SELECT r.id, r.name FROM student_target_roles t JOIN career_roles r ON r.id = t.role_id WHERE t.student_id = $1`, [req.user.id])).rows[0];
  res.json({ role: r || null });
}));

student.put('/target-role', ...studentOnly, validate({ body: z.object({ roleId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const role = (await pool.query('SELECT id, name FROM career_roles WHERE id = $1 AND is_active', [req.body.roleId])).rows[0];
  if (!role) throw badRequest('INVALID_ROLE', 'Unknown role');
  await pool.query(
    `INSERT INTO student_target_roles (student_id, role_id) VALUES ($1,$2)
     ON CONFLICT (student_id) DO UPDATE SET role_id = EXCLUDED.role_id, updated_at = now()`, [req.user.id, role.id]);
  res.json({ role });
}));

// ----------------------------------------------------------------------------- skill gap
/** Resolve ?roleId (or the saved target role) and the role's requirements. */
async function resolveRole(studentId, roleId) {
  let id = roleId;
  if (!id) id = (await pool.query('SELECT role_id FROM student_target_roles WHERE student_id = $1', [studentId])).rows[0]?.role_id;
  if (!id) return null;
  const role = (await pool.query('SELECT id, name, description FROM career_roles WHERE id = $1 AND is_active', [id])).rows[0];
  if (!role) throw notFound('Role');
  const reqs = (await pool.query(
    `SELECT s.id AS skill_id, s.name, rs.required_level, rs.weight FROM role_skills rs JOIN skills s ON s.id = rs.skill_id WHERE rs.role_id = $1 ORDER BY rs.weight DESC, s.name`, [id])).rows
    .map((r) => ({ skillId: r.skill_id, skillName: r.name, requiredLevel: r.required_level, weight: Number(r.weight) }));
  return { role, requirements: reqs };
}

const bestLevels = (rows) => {
  const best = {};
  for (const r of rows) best[r.skill_id] = Math.max(best[r.skill_id] || 0, r.proficiency);
  return best;
};

/** Compute both gap variants + radar rows for a student/role. */
async function analyse(studentId, roleId) {
  const resolved = await resolveRole(studentId, roleId);
  if (!resolved) return null;
  const owned = await loadOwned(studentId);
  const all = bestLevels(owned);
  const ver = bestLevels(owned.filter((r) => r.verified));
  const gapAll = scoring.skillGap(resolved.requirements, all);
  const gapVer = scoring.skillGap(resolved.requirements, ver);
  const names = new Map(resolved.requirements.map((r) => [r.skillId, r.skillName]));
  return {
    role: resolved.role, requirements: resolved.requirements, all, ver,
    gapPct: gapAll.gapPct, readinessPct: gapAll.readinessPct, verifiedGapPct: gapVer.gapPct, verifiedReadinessPct: gapVer.readinessPct,
    radar: gapAll.perSkill.map((p, i) => ({
      skillId: p.skillId, skill: names.get(p.skillId), required: p.required, have: p.have,
      haveVerified: gapVer.perSkill[i].have, coveragePct: p.coveragePct, weight: p.weight,
    })),
  };
}

// GET /student/skill-gap?roleId=   (also records today's snapshot so progress can be charted)
student.get('/skill-gap', ...approvedStudentOnly, validate({ query: z.object({ roleId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const a = await analyse(req.user.id, req.query.roleId);
  if (!a) return res.json({ role: null, message: 'Choose a target role to see your skill gap' });
  await pool.query(
    `INSERT INTO skill_gap_snapshots (student_id, role_id, gap_percent, verified_gap_percent, details)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (student_id, role_id, snapshot_date)
     DO UPDATE SET gap_percent = EXCLUDED.gap_percent, verified_gap_percent = EXCLUDED.verified_gap_percent, details = EXCLUDED.details`,
    [req.user.id, a.role.id, a.gapPct, a.verifiedGapPct, JSON.stringify(a.radar)]);
  res.json({
    role: a.role, gapPct: a.gapPct, readinessPct: a.readinessPct, verifiedGapPct: a.verifiedGapPct, verifiedReadinessPct: a.verifiedReadinessPct,
    radar: a.radar,
    missing: a.radar.filter((r) => r.have < r.required).sort((x, y) => y.weight * (1 - y.coveragePct / 100) - x.weight * (1 - x.coveragePct / 100)),
  });
}));

// GET /student/skill-gap/roadmap?roleId=&hoursPerWeek=6
student.get('/skill-gap/roadmap', ...approvedStudentOnly, validate({ query: z.object({
  roleId: z.string().uuid().optional(), hoursPerWeek: z.coerce.number().int().min(1).max(60).default(6),
}) }), asyncHandler(async (req, res) => {
  const a = await analyse(req.user.id, req.query.roleId);
  if (!a) return res.json({ role: null, phases: [], totalWeeks: 0, totalHours: 0 });
  const resources = (await pool.query(
    `SELECT skill_id, title, provider, url, level, est_hours FROM learning_resources WHERE skill_id = ANY($1::uuid[])`,
    [a.requirements.map((r) => r.skillId)])).rows;
  res.json({ role: a.role, ...buildRoadmap({ requirements: a.requirements, owned: a.all, resources, hoursPerWeek: req.query.hoursPerWeek }) });
}));

// GET /student/skill-gap/history?roleId=  — progress: gap % over time
student.get('/skill-gap/history', ...approvedStudentOnly, validate({ query: z.object({ roleId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  let roleId = req.query.roleId;
  if (!roleId) roleId = (await pool.query('SELECT role_id FROM student_target_roles WHERE student_id = $1', [req.user.id])).rows[0]?.role_id;
  if (!roleId) return res.json({ history: [] });
  const { rows } = await pool.query(
    `SELECT snapshot_date::text AS date, gap_percent, verified_gap_percent FROM skill_gap_snapshots
      WHERE student_id = $1 AND role_id = $2 ORDER BY snapshot_date`, [req.user.id, roleId]);
  res.json({ history: rows.map((r) => ({ date: r.date, gapPct: Number(r.gap_percent), verifiedGapPct: Number(r.verified_gap_percent) })) });
}));

module.exports = { catalog, student, analyse, loadOwned };
