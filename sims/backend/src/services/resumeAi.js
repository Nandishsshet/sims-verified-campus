'use strict';
/**
 * Resume writing assistant.
 *
 * Layer 1 (always on, offline, deterministic): rule-based checks and rewrites.
 * Layer 2 (optional): if ANTHROPIC_API_KEY is set, the rule output is refined by a Claude
 * model. The student's text is then sent to Anthropic — leave the key unset to keep all
 * resume content on your own server. Any failure silently falls back to Layer 1.
 */
const { ACTION_VERBS, firstWord, words } = require('./ats');

const WEAK_STARTS = [
  [/^(worked on|worked with|working on)\s+/i, 'Developed '],
  [/^responsible for\s+/i, 'Led '],
  [/^(helped to|helped)\s+/i, 'Supported '],
  [/^was involved in\s+/i, 'Contributed to '],
  [/^(participated in|took part in)\s+/i, 'Collaborated on '],
  [/^assisted (in|with)\s+/i, 'Supported '],
  [/^(made|did)\s+/i, 'Built '],
  [/^i\s+(have\s+|had\s+|was\s+|am\s+)?/i, ''],
];

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clean = (s) => String(s || '').replace(/^[\s•\-–*·]+/, '').replace(/\s+/g, ' ').trim();

/** Rule-based analysis of one bullet point. */
function improveBullet(text) {
  const original = clean(text);
  const issues = [];
  let rewritten = original;

  const weak = WEAK_STARTS.find(([re]) => re.test(rewritten));
  if (weak) {
    rewritten = cap(rewritten.replace(weak[0], weak[1]));
    issues.push({ code: 'weak_start', message: 'Starts with a weak or passive phrase. Lead with a strong action verb.' });
  } else if (original && !ACTION_VERBS.has(firstWord(original))) {
    issues.push({ code: 'no_action_verb', message: 'Does not start with an action verb (Built, Reduced, Led…).' });
  }
  if (/\b(i|my|me)\b/i.test(original)) issues.push({ code: 'first_person', message: 'Avoid first-person words — resume bullets are written without "I" or "my".' });
  const n = words(original).length;
  if (n && n < 6) issues.push({ code: 'too_short', message: 'Too short — say what you did, how, and the result.' });
  if (n > 30) issues.push({ code: 'too_long', message: 'Too long — keep bullets to one or two lines (under 30 words).' });
  const quantified = /\d/.test(original);
  if (original && !quantified) issues.push({ code: 'no_metric', message: 'No numbers. Add scale or impact (users, %, time saved, data size).' });

  const suggestions = [];
  if (original) {
    const base = rewritten.replace(/[.\s]+$/, '');
    if (rewritten !== original) suggestions.push(`${base}.`);
    if (!quantified) suggestions.push(`${base}, resulting in [X% improvement / N users / N hours saved].`);
    if (!suggestions.length) suggestions.push(`${base}.`);
  }
  return { original, issues, suggestions, quality: Math.max(0, 100 - issues.length * 20) };
}

/** Rule-based analysis + draft for the summary. ctx comes from the student's verified data. */
function improveSummary(text, ctx = {}) {
  const original = clean(text);
  const issues = [];
  const n = words(original).length;
  if (n === 0) issues.push({ code: 'empty', message: 'No summary yet.' });
  else if (n < 25) issues.push({ code: 'too_short', message: 'Too short — aim for 35–70 words.' });
  else if (n > 80) issues.push({ code: 'too_long', message: 'Too long — keep the summary under 80 words.' });
  if (/\b(i|my|me)\b/i.test(original)) issues.push({ code: 'first_person', message: 'Write in implied first person (no "I" or "my").' });
  if (original && !/\d/.test(original)) issues.push({ code: 'no_metric', message: 'Add a concrete fact (CGPA, number of projects, internship duration).' });
  if (ctx.targetRole && original && !original.toLowerCase().includes(ctx.targetRole.toLowerCase().split(' ')[0])) {
    issues.push({ code: 'no_target', message: `Mention the role you are targeting (${ctx.targetRole}).` });
  }

  const skills = (ctx.topSkills || []).slice(0, 4);
  const bits = [];
  bits.push(`${ctx.branch ? `${ctx.branch} ` : ''}student${ctx.college ? ` at ${ctx.college}` : ''}${ctx.cgpa ? ` with a CGPA of ${Number(ctx.cgpa).toFixed(2)}` : ''}`);
  if (skills.length) bits.push(`skilled in ${skills.slice(0, -1).join(', ')}${skills.length > 1 ? ' and ' : ''}${skills[skills.length - 1]}`);
  if (ctx.projectCount) bits.push(`having built ${ctx.projectCount} verified project${ctx.projectCount > 1 ? 's' : ''}`);
  if (ctx.certCount) bits.push(`holding ${ctx.certCount} verified certification${ctx.certCount > 1 ? 's' : ''}`);
  const draft = `${cap(bits.join(', '))}. ${ctx.targetRole ? `Seeking a ${ctx.targetRole} role where I can apply and grow these skills.` : 'Seeking an opportunity to apply and grow these skills.'}`
    .replace(/\bI can\b/, 'to');
  return { original, issues, suggestions: [draft], source: 'rules' };
}

// ------------------------------------------------------------------ optional LLM refinement
async function refineWithLlm(kind, text, ruleResult, ctx) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || typeof fetch !== 'function') return null;
  try {
    const prompt = kind === 'summary'
      ? `Rewrite this resume summary in 35-60 words, no first-person pronouns. Use ONLY these facts; never invent numbers or employers.\nFacts: ${JSON.stringify(ctx)}\nCurrent summary: ${text || '(none)'}\nReturn 2 alternative versions, one per line, no numbering.`
      : `Improve this resume bullet. Start with a strong action verb, keep it under 25 words, keep facts intact and use [X] as a placeholder where a metric is missing. Never invent numbers.\nBullet: ${text}\nReturn 2 alternative versions, one per line, no numbering.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const lines = (body.content?.[0]?.text || '').split('\n').map((l) => clean(l)).filter(Boolean).slice(0, 2);
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

async function improve({ section, text, ctx }) {
  const rules = section === 'summary' ? improveSummary(text, ctx) : { ...improveBullet(text), source: 'rules' };
  const llm = await refineWithLlm(section === 'summary' ? 'summary' : 'bullet', clean(text), rules, ctx);
  return llm ? { ...rules, suggestions: [...llm, ...rules.suggestions], source: 'llm+rules' } : rules;
}

module.exports = { improveBullet, improveSummary, improve };
