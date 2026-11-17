'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scoring = require('../src/services/scoring');
const { deriveMark, computeAcademics } = require('../src/services/academics');
const { scoreResume } = require('../src/services/ats');
const { buildRoadmap } = require('../src/services/roadmap');
const { improveBullet, improveSummary } = require('../src/services/resumeAi');
const { buildSuggestions, evaluateBadges } = require('../src/services/insights');

// ------------------------------------------------------------------ academics
test('deriveMark: grade, pass and the external-minimum rule', () => {
  const ok = deriveMark({ internalObtained: 30, internalMax: 40, externalObtained: 50, externalMax: 60 });
  assert.deepEqual([ok.percentage, ok.pass, ok.gradePoints, ok.grade], [80, true, 9, 'A+']);
  const fail = deriveMark({ internalObtained: 40, internalMax: 40, externalObtained: 20, externalMax: 60 });
  assert.deepEqual([fail.percentage, fail.pass, fail.gradePoints, fail.grade], [60, false, 0, 'F']);
});

test('computeAcademics: SGPA, CGPA, backlogs, and a cleared backlog replaces the failed attempt', () => {
  const row = (subject_id, semester, credits, gp, pass, attempt = 1) => ({ subject_id, semester, credits, grade_points: gp, is_pass: pass, attempt, code: subject_id, name: subject_id });
  const rows = [row('S1', 1, 4, 9, true), row('S2', 1, 2, 0, false), row('S3', 2, 4, 8, true)];
  const a = computeAcademics(rows);
  assert.deepEqual(a.semesters.map((s) => s.sgpa), [6, 8]);          // (4×9)/6 = 6
  assert.equal(a.cgpa, 6.8);                                          // (6×6 + 4×8)/10
  assert.equal(a.activeBacklogs.length, 1);
  assert.equal(a.creditsDone, 10);

  const cleared = computeAcademics([...rows, row('S2', 1, 2, 6, true, 2)]);
  assert.deepEqual(cleared.semesters.map((s) => s.sgpa), [8, 8]);     // (36+12)/6
  assert.equal(cleared.cgpa, 8);
  assert.equal(cleared.activeBacklogs.length, 0);
  assert.deepEqual(computeAcademics([]), { semesters: [], trend: [], cgpa: 0, creditsDone: 0, activeBacklogs: [] });
});

test('missableInRemaining', () => {
  assert.equal(scoring.missableInRemaining(40, 50, 20), 7);      // must attend 13 of 20
  assert.equal(scoring.missableInRemaining(50, 50, 10), 10);     // already safe
  assert.equal(scoring.missableInRemaining(10, 50, 5), null);    // cannot recover in time
});

// ------------------------------------------------------------------ ATS
const goodData = () => ({
  personal: { email: 'a@b.co', phone: '9999999999', github: 'https://github.com/a' },
  summary: 'Computer Science student with a CGPA of 8.4, skilled in JavaScript, React and SQL, having built three verified projects and seeking a web developer role.',
  skills: ['JavaScript', 'React', 'Node.js', 'SQL', 'Git', 'HTML'].map((name) => ({ name })),
  education: [{ institution: 'Test College', degree: 'B.Tech CSE' }],
  projects: [{ title: 'Campus portal', tech: ['React', 'Node.js'], bullets: ['Built a campus portal serving 500 students', 'Reduced page load time by 40% using caching'] }],
  experience: [], certificates: [{ title: 'React Basics', issuer: 'Coursera' }], achievements: [],
});

test('ATS: scores a strong resume high and breaks the score down', () => {
  const r = scoreResume({ data: goodData(), roleKeywords: ['JavaScript', 'React', 'SQL'], templateKey: 'classic' });
  const by = Object.fromEntries(r.breakdown.map((b) => [b.key, b]));
  assert.equal(by.keywords.points, 30);
  assert.equal(by.quantified.points, 15);
  assert.equal(by.verbs.points, 10);
  assert.equal(by.contact.points, 5);
  assert.equal(by.format.points, 10);
  assert.equal(by.completeness.points, 20);
  assert.ok(r.score >= 80, `score ${r.score}`);
  assert.equal(r.breakdown.reduce((s, b) => s + b.max, 0), 100);
});

test('ATS: empty resume scores low with actionable tips; two-column template loses format points', () => {
  const empty = scoreResume({ data: { personal: {}, skills: [], projects: [], experience: [], certificates: [], achievements: [], education: [] }, roleKeywords: ['React'], templateKey: 'modern' });
  assert.ok(empty.score < 25);
  assert.ok(empty.suggestions.length >= 3);
  const modern = scoreResume({ data: goodData(), roleKeywords: ['JavaScript'], templateKey: 'modern' });
  assert.equal(modern.breakdown.find((b) => b.key === 'format').points, 7);
});

test('ATS: keyword match is partial and names the missing keywords', () => {
  const r = scoreResume({ data: goodData(), roleKeywords: ['React', 'Docker', 'Kubernetes', 'AWS'] });
  const k = r.breakdown.find((b) => b.key === 'keywords');
  assert.equal(k.points, 7.5);
  assert.match(k.tip, /Docker/);
});

// ------------------------------------------------------------------ roadmap
test('roadmap: orders by weight × gap, chains resources, lays out a weekly timeline', () => {
  const requirements = [
    { skillId: 'sql', skillName: 'SQL', requiredLevel: 3, weight: 1 },
    { skillId: 'js', skillName: 'JavaScript', requiredLevel: 4, weight: 3 },
    { skillId: 'git', skillName: 'Git', requiredLevel: 2, weight: 1 },
  ];
  const resources = [
    { skill_id: 'js', title: 'JS basics', level: 3, est_hours: 40 }, { skill_id: 'js', title: 'JS advanced', level: 4, est_hours: 20 },
    { skill_id: 'sql', title: 'SQL course', level: 3, est_hours: 30 },
  ];
  const r = buildRoadmap({ requirements, owned: { js: 2, git: 2 }, resources, hoursPerWeek: 6 });
  assert.deepEqual(r.phases.map((p) => p.skill), ['JavaScript', 'SQL']);          // Git already satisfied
  const [js, sql] = r.phases;
  assert.equal(js.resources.length, 2);
  assert.deepEqual([js.hours, js.startWeek, js.endWeek, js.fullyCovered], [60, 1, 10, true]);
  assert.deepEqual([sql.startWeek, sql.endWeek], [11, 15]);
  assert.equal(r.totalWeeks, 15);
  assert.equal(r.totalHours, 90);
});

test('roadmap: a skill without catalogue courses gets a practice estimate', () => {
  const r = buildRoadmap({ requirements: [{ skillId: 'x', skillName: 'X', requiredLevel: 3, weight: 1 }], owned: { x: 1 }, resources: [], hoursPerWeek: 5 });
  assert.equal(r.phases[0].hours, 20);
  assert.equal(r.phases[0].fullyCovered, false);
  assert.match(r.phases[0].note, /project/);
});

// ------------------------------------------------------------------ writing assistant
test('improveBullet: flags weak start and missing metric, proposes a rewrite', () => {
  const r = improveBullet('Worked on a website for the college');
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('weak_start') && codes.includes('no_metric'));
  assert.match(r.suggestions[0], /^Developed a website for the college/);
  assert.ok(r.suggestions.some((s) => s.includes('[X')));
  const good = improveBullet('Built an API serving 10k users daily');
  assert.deepEqual(good.issues, []);
  assert.equal(good.quality, 100);
});

test('improveSummary: drafts only from supplied facts', () => {
  const r = improveSummary('', { branch: 'CSE', college: 'Test College', cgpa: 8.4, topSkills: ['React', 'SQL'], projectCount: 2, targetRole: 'Web Developer' });
  assert.equal(r.issues[0].code, 'empty');
  const s = r.suggestions[0];
  assert.match(s, /CSE student at Test College with a CGPA of 8\.40/);
  assert.match(s, /React and SQL/);
  assert.match(s, /2 verified projects/);
  assert.ok(!/certification/.test(s), 'no certificate claim when there are none');
});

// ------------------------------------------------------------------ suggestions & badges
test('suggestions: most urgent first, capped, never empty', () => {
  const s = buildSuggestions({ held: 100, attendancePct: 60, toRecover: 60, canMiss: 0, lowSubjects: [], activeBacklogs: 1, sgpaDrop: 0, hasTargetRole: false, certCount: 0, projectCount: 0, resumeScore: null, rejectedCount: 1, pendingCount: 2 });
  assert.equal(s[0].id, 'low_attendance');
  assert.equal(s[0].severity, 'critical');
  assert.ok(s.length <= 8);
  const fine = buildSuggestions({ held: 100, attendancePct: 95, toRecover: 0, canMiss: 20, lowSubjects: [], activeBacklogs: 0, sgpaDrop: 0, hasTargetRole: true, verifiedGapPct: 10, certCount: 3, projectCount: 3, resumeScore: 85, rejectedCount: 0, pendingCount: 0 });
  assert.equal(fine[0].id, 'on_track');
});

test('badges are awarded from verified metrics only', () => {
  const m = { certCount: 5, held: 50, attendancePct: 92, cgpa: 8.2, semesterCount: 2, activeBacklogs: 0, projectCount: 3, hasTargetRole: true, verifiedGapPct: 15, resumeScore: 82, classSize: 10, rank: 2 };
  assert.deepEqual(evaluateBadges(m).sort(), ['ALL_CLEAR', 'ATTENDANCE_90', 'BUILDER', 'CERT_COLLECTOR', 'FIRST_CERT', 'PODIUM', 'RESUME_PRO', 'SCHOLAR', 'SKILL_STAR']);
  assert.deepEqual(evaluateBadges({ certCount: 0, held: 0, attendancePct: 0, cgpa: 0, semesterCount: 0, activeBacklogs: 0, projectCount: 0, hasTargetRole: false, resumeScore: null, classSize: 1, rank: 1 }), []);
});
