'use strict';
/**
 * Deterministic ATS score for a resume (docs/SCORING.md §6). Pure function — AI rewriting
 * is a separate, optional layer; the score itself never depends on a model.
 *
 * data = merged resume data (see modules/student/resume/resumeData.js):
 *   { personal:{email,phone,linkedin,github}, summary, skills:[{name}], projects:[{title,tech[],bullets[]}],
 *     experience:[{bullets[]}], certificates:[], achievements:[], education:[] }
 */
const { round } = require('./scoring');

const ACTION_VERBS = new Set(`achieved analyzed architected automated built collaborated configured contributed created debugged
delivered deployed designed developed devised diagnosed documented drove engineered enhanced established evaluated executed
expanded implemented improved increased initiated integrated introduced launched led maintained managed migrated mentored
modeled monitored optimized organized orchestrated owned partnered planned presented prototyped published reduced refactored
researched resolved reviewed scaled shipped simplified solved spearheaded streamlined supported tested trained translated
tuned upgraded validated visualized wrote coordinated administered accelerated authored boosted cleaned compiled conducted
consolidated customized decreased defined demonstrated discovered exceeded facilitated formulated generated identified
leveraged mapped measured negotiated operated performed produced programmed revamped secured standardized strengthened
structured taught unified won`.split(/\s+/));

// Two-column / sidebar layouts parse poorly in many ATS; single-column templates get full marks.
const TEMPLATE_ATS_POINTS = { classic: 10, compact: 10, academic: 10, minimal: 10, modern: 7 };

const words = (s) => (s ? String(s).trim().split(/\s+/).filter(Boolean) : []);
const firstWord = (s) => (words(s)[0] || '').toLowerCase().replace(/[^a-z]/g, '');

function allBullets(data) {
  return [...(data.projects || []), ...(data.experience || [])].flatMap((x) => x.bullets || []).filter((b) => b && b.trim());
}

function corpusOf(data) {
  const parts = [data.summary, ...(data.skills || []).map((s) => s.name)];
  for (const p of data.projects || []) parts.push(p.title, ...(p.tech || []), ...(p.bullets || []));
  for (const e of data.experience || []) parts.push(e.title, e.organization, ...(e.bullets || []));
  for (const c of data.certificates || []) parts.push(c.title);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function wordCount(data) {
  const parts = [data.summary, ...(data.skills || []).map((s) => s.name)];
  for (const sec of ['projects', 'experience', 'publications']) {
    for (const x of data[sec] || []) parts.push(x.title, x.organization, x.role, ...(x.bullets || []), ...(x.tech || []));
  }
  for (const c of data.certificates || []) parts.push(c.title, c.issuer);
  for (const a of data.achievements || []) parts.push(a.title, a.detail);
  for (const e of data.education || []) parts.push(e.institution, e.degree);
  return words(parts.filter(Boolean).join(' ')).length;
}

/** @returns {{score:number, breakdown:Array, suggestions:string[]}} */
function scoreResume({ data, roleKeywords = [], templateKey = 'classic' }) {
  const breakdown = [];
  const add = (key, label, points, max, tip) => breakdown.push({ key, label, points: round(points, 1), max, tip: points < max * 0.7 ? tip : null });

  // 1. Role keywords (30)
  if (roleKeywords.length) {
    const corpus = corpusOf(data);
    const missing = roleKeywords.filter((k) => !corpus.includes(k.toLowerCase()));
    const matched = roleKeywords.length - missing.length;
    add('keywords', 'Target-role keywords', (30 * matched) / roleKeywords.length, 30,
      `Add evidence for: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''} (only if you genuinely have these skills).`);
  } else {
    add('keywords', 'Target-role keywords', 15, 30, 'Choose a target role so your resume can be matched against its keywords.');
  }

  // 2. Section completeness (20): 4 points each
  const summaryWords = words(data.summary).length;
  const has = {
    summary: summaryWords >= 20,
    education: (data.education || []).length > 0,
    skills: (data.skills || []).length >= 5,
    work: (data.projects || []).length + (data.experience || []).length > 0,
    proof: (data.certificates || []).length + (data.achievements || []).length > 0,
  };
  const missingSections = [];
  if (!has.summary) missingSections.push('a summary of at least 20 words');
  if (!has.education) missingSections.push('education');
  if (!has.skills) missingSections.push('at least 5 skills');
  if (!has.work) missingSections.push('a project or internship');
  if (!has.proof) missingSections.push('a certificate or achievement');
  add('completeness', 'Section completeness', 4 * Object.values(has).filter(Boolean).length, 20, `Add ${missingSections.join(', ')}.`);

  // 3. Quantified bullets (15)  4. Action verbs (10)
  const bullets = allBullets(data);
  const quantified = bullets.filter((b) => /\d/.test(b)).length;
  add('quantified', 'Quantified bullets', bullets.length ? (15 * quantified) / bullets.length : 0, 15,
    bullets.length ? `Add numbers (users, %, time saved, size) to ${bullets.length - quantified} bullet(s).` : 'Add 2–4 bullet points under each project or internship.');
  const verbs = bullets.filter((b) => ACTION_VERBS.has(firstWord(b))).length;
  add('verbs', 'Action verbs', bullets.length ? (10 * verbs) / bullets.length : 0, 10,
    bullets.length ? `Start ${bullets.length - verbs} bullet(s) with a strong action verb (Built, Reduced, Led…).` : 'Bullets should start with action verbs.');

  // 5. Length (10)
  const wc = wordCount(data);
  const lengthPts = wc < 80 ? 0 : wc < 150 ? 3 : wc < 250 ? 6 : wc <= 700 ? 10 : wc <= 900 ? 6 : 2;
  add('length', 'Length & density', lengthPts, 10,
    wc < 250 ? `Resume is thin (${wc} words) — aim for 250–700.` : `Resume is long (${wc} words) — trim to one page (≤700 words).`);

  // 6. Contact completeness (5)
  const p = data.personal || {};
  add('contact', 'Contact details', (p.email ? 2 : 0) + (p.phone ? 1.5 : 0) + (p.linkedin || p.github ? 1.5 : 0), 5,
    'Include email, phone and a LinkedIn or GitHub link.');

  // 7. ATS-safe format (10)
  const formatPts = TEMPLATE_ATS_POINTS[templateKey] ?? 8;
  add('format', 'ATS-safe format', formatPts, 10, 'Switch to a single-column template (Classic, Compact, Academic or Minimal).');

  const score = Math.round(breakdown.reduce((s, b) => s + b.points, 0));
  const suggestions = breakdown
    .filter((b) => b.tip)
    .sort((a, b) => (b.max - b.points) - (a.max - a.points))
    .map((b) => b.tip);
  return { score, breakdown, suggestions };
}

module.exports = { ACTION_VERBS, TEMPLATE_ATS_POINTS, scoreResume, firstWord, words };
