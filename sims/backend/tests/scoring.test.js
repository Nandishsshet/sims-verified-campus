'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/services/scoring');

test('grade points follow the 10-point scale', () => {
  assert.equal(s.gradePoints(92), 10);
  assert.equal(s.gradePoints(75), 8);
  assert.equal(s.gradePoints(40), 4);
  assert.equal(s.gradePoints(39.9), 0);
});

test('pass requires total >= 40% AND external >= 40%', () => {
  assert.equal(s.isPass({ internalObtained: 38, internalMax: 40, externalObtained: 20, externalMax: 60 }), false); // ext 33%
  assert.equal(s.isPass({ internalObtained: 20, internalMax: 40, externalObtained: 25, externalMax: 60 }), true);
});

test('SGPA and CGPA are credit-weighted', () => {
  assert.equal(s.sgpa([{ credits: 4, gradePoints: 9 }, { credits: 2, gradePoints: 6 }]), 8); // (36+12)/6
  assert.equal(s.cgpa([{ credits: 20, sgpa: 8 }, { credits: 20, sgpa: 9 }]), 8.5);
});

test('GPA predictor', () => {
  assert.deepEqual(s.requiredSgpa({ currentCgpa: 7.5, creditsDone: 100, creditsNext: 25, targetCgpa: 7.8 }),
    { required: 9, feasible: true });
  assert.equal(s.requiredSgpa({ currentCgpa: 7.5, creditsDone: 100, creditsNext: 25, targetCgpa: 9 }).feasible, false);
});

test('attendance calculators', () => {
  assert.equal(s.classesCanMiss(40, 50), 3);        // 40/53 = 75.47%, 40/54 = 74.07%
  assert.equal(s.classesCanMiss(30, 50), 0);        // already below
  assert.equal(s.classesToRecover(30, 50), 30);     // 60/80 = 75%
  assert.equal(s.classesToRecover(45, 50), 0);
});

test('skill gap: over-qualification is capped, weights respected', () => {
  const req = [{ skillId: 'js', requiredLevel: 4, weight: 2 }, { skillId: 'sql', requiredLevel: 3, weight: 1 }];
  const r = s.skillGap(req, { js: 2, sql: 5 });
  assert.equal(r.readinessPct, 66.67);
  assert.equal(r.gapPct, 33.33);
});

test('leaderboard: default weights sum to 100 and perfect student scores 100', () => {
  const perfect = { marks: 100, attendance: 100, certificates: 100, skills: 100, resume: 100, activity: 100 };
  assert.equal(s.leaderboardScore(perfect), 100);
  assert.throws(() => s.leaderboardScore(perfect, { ...s.DEFAULT_LEADERBOARD_WEIGHTS, marks: 50 }));
});

test('ranking uses tie-breakers and shared ranks', () => {
  const c = { marks: 80, attendance: 80, certificates: 0, skills: 0, resume: 0, activity: 0 };
  const ranked = s.rankStudents([
    { id: 1, name: 'B', components: c, cgpa: 8, attendance: 80 },
    { id: 2, name: 'A', components: c, cgpa: 8, attendance: 80 },   // identical => shared rank, name order
    { id: 3, name: 'C', components: { ...c, marks: 90 }, cgpa: 9, attendance: 80 },
  ]);
  assert.deepEqual(ranked.map((r) => [r.id, r.rank]), [[3, 1], [2, 2], [1, 2]]);
});

test('certificate and activity scores cap at 100', () => {
  assert.equal(s.certificateScore([{ category: 'internship' }, { category: 'hackathon' }, { category: 'course' }]), 70);
  assert.equal(s.certificateScore(Array(10).fill({ category: 'internship' })), 100);
  assert.equal(s.activityScore([{ status: 'winner' }, { status: 'attended' }]), 58.33);
});

test('placement readiness applies the backlog penalty', () => {
  const base = { cgpa: 8, skillReadinessPct: 70, certScore: 60, portfolioScore: 60, resumeScore: 80, attendancePct: 90, activeBacklogs: 0 };
  const a = s.placementReadiness(base);
  assert.equal(s.placementReadiness({ ...base, activeBacklogs: 2 }), a - 10);
});

test('department score flags weak metrics', () => {
  const r = s.departmentScore({ avgSgpa: 7, attendancePct: 55, passPct: 90, certsPerStudent: 1,
    placementReadiness: 70, skillGapPct: 55, eventParticipationPct: 80 });
  assert.deepEqual(r.weak.sort(), ['attendance', 'certificates', 'skills'].sort());
  assert.ok(r.score > 0 && r.score < 100);
});

test('dropout risk bands', () => {
  assert.equal(s.dropoutRisk({ attendancePct: 95, sgpa: 8.5, prevSgpa: 8, backlogs: 0, activityScore: 80 }).band, 'low');
  assert.equal(s.dropoutRisk({ attendancePct: 40, sgpa: 3, prevSgpa: 5, backlogs: 5, activityScore: 0 }).band, 'high');
});
