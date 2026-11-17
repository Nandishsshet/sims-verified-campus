'use strict';
/**
 * Resume content assembly.
 *   buildResumeData  — auto-fill from the student's VERIFIED records only
 *   mergeContent     — layer the student's own edits (summary, extra skills, reworded bullets, hidden items)
 * The merged object is what the templates render and what the ATS scorer reads.
 */
const { pool } = require('../../db/pool');
const { loadMetrics } = require('../student/metrics.service');
const { loadOwned } = require('../skills/skills.routes');

const SECTIONS = ['summary', 'education', 'skills', 'projects', 'experience', 'publications', 'certificates', 'achievements'];
const DEFAULT_ORDER = ['summary', 'education', 'skills', 'projects', 'experience', 'certificates', 'achievements'];
const TEMPLATES = [
  { key: 'classic', name: 'Classic', description: 'Single column, serif headings. The safest choice for ATS.', atsSafe: true },
  { key: 'compact', name: 'Compact', description: 'Dense single column — fits more on one page.', atsSafe: true },
  { key: 'academic', name: 'Academic', description: 'Education first, publication friendly.', atsSafe: true },
  { key: 'minimal', name: 'Minimal', description: 'Clean sans-serif with generous spacing.', atsSafe: true },
  { key: 'modern', name: 'Modern', description: 'Two-column with a skills sidebar. Looks sharp, parses less reliably in some ATS.', atsSafe: false },
];

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const bulletsOf = (r) => (r.bullets?.length ? r.bullets : r.description ? [r.description] : []);

/** Verified-only assembly. Also returns `facts` used by the writing assistant. */
async function buildResumeData(studentId) {
  const [prof, owned, items, certs, acts, metrics] = await Promise.all([
    pool.query(
      `SELECT u.full_name, u.email, u.phone, p.summary, p.linkedin_url, p.github_url, p.address,
              c.branch, c.admission_year, c.passout_year, col.name AS college, uni.name AS university
         FROM users u JOIN student_profiles p ON p.user_id = u.id
         LEFT JOIN class_enrollments e ON e.student_id = u.id AND e.status = 'approved'
         LEFT JOIN classes c ON c.id = e.class_id
         LEFT JOIN colleges col ON col.id = c.college_id
         LEFT JOIN universities uni ON uni.id = col.university_id
        WHERE u.id = $1`, [studentId]),
    loadOwned(studentId),
    pool.query(`SELECT * FROM portfolio_items WHERE student_id = $1 AND verification_status = 'verified' ORDER BY COALESCE(end_date, start_date) DESC NULLS LAST`, [studentId]),
    pool.query(`SELECT id, title, issuer, issue_date, verification_code FROM certificates WHERE student_id = $1 AND verification_status = 'verified' ORDER BY issue_date DESC NULLS LAST`, [studentId]),
    pool.query(
      `SELECT a.id, a.title, a.type, p.status FROM activity_participants p JOIN activities a ON a.id = p.activity_id
        WHERE p.student_id = $1 AND a.is_published AND p.status IN ('winner','runner_up') ORDER BY a.starts_at DESC`, [studentId]),
    loadMetrics(pool, [studentId]),
  ]);
  const p = prof.rows[0];
  const m = metrics.get(studentId);

  // best verified level per skill
  const best = new Map();
  for (const r of owned.filter((x) => x.verified)) {
    const cur = best.get(r.skill_id);
    if (!cur || r.proficiency > cur.level) best.set(r.skill_id, { name: r.name, category: r.category, level: r.proficiency });
  }
  const skills = [...best.values()].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));

  const byType = (t) => items.rows.filter((r) => r.type === t);
  const data = {
    personal: { name: p.full_name, email: p.email, phone: p.phone || null, linkedin: p.linkedin_url || null, github: p.github_url || null, location: p.address || null },
    summary: p.summary || '',
    education: p.branch ? [{
      id: 'education', institution: p.college, university: p.university, degree: p.branch,
      start: p.admission_year, end: p.passout_year, cgpa: m.semesterCount ? m.cgpa : null,
    }] : [],
    skills,
    projects: byType('project').map((r) => ({ id: r.id, title: r.title, organization: r.organization, tech: r.tech_stack, bullets: bulletsOf(r), url: r.url, start: ymd(r.start_date), end: ymd(r.end_date) })),
    experience: byType('internship').map((r) => ({ id: r.id, title: r.role || 'Intern', organization: r.organization, bullets: bulletsOf(r), start: ymd(r.start_date), end: ymd(r.end_date) })),
    publications: byType('publication').map((r) => ({ id: r.id, title: r.title, organization: r.organization, url: r.url, date: ymd(r.end_date || r.start_date), bullets: [] })),
    certificates: certs.rows.map((r) => ({ id: r.id, title: r.title, issuer: r.issuer, date: ymd(r.issue_date), code: r.verification_code })),
    achievements: acts.rows.map((r) => ({ id: r.id, title: r.title, detail: r.status === 'winner' ? 'Winner' : 'Runner-up' })),
  };
  const facts = { branch: p.branch, college: p.college, cgpa: m.semesterCount ? m.cgpa : null, topSkills: skills.slice(0, 4).map((s) => s.name), projectCount: data.projects.length, certCount: data.certificates.length };
  return { data, facts };
}

/** Apply the student's edits on top of the verified auto-fill. */
function mergeContent(data, content = {}) {
  const hidden = new Set(content.hidden || []);
  const keep = (list) => list.filter((x) => !hidden.has(x.id));
  const reword = (list) => keep(list).map((x) => (content.bullets && Array.isArray(content.bullets[x.id]) ? { ...x, bullets: content.bullets[x.id] } : x));

  const have = new Set(data.skills.map((s) => s.name.toLowerCase()));
  const extra = (content.extraSkills || []).filter((n) => !have.has(n.toLowerCase())).map((name) => ({ name, level: null, extra: true }));

  return {
    ...data,
    personal: { ...data.personal, ...(content.contact || {}) },
    summary: content.summary ?? data.summary,
    skills: [...data.skills, ...extra],
    projects: reword(data.projects),
    experience: reword(data.experience),
    publications: keep(data.publications),
    certificates: keep(data.certificates),
    achievements: keep(data.achievements),
  };
}

module.exports = { SECTIONS, DEFAULT_ORDER, TEMPLATES, buildResumeData, mergeContent };
