'use strict';
/** Pure university roll-up logic (no database): rollUp, sgpaTrend, buildUniversityInsights. */
require('./helpers/env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rollUp, sgpaTrend, buildUniversityInsights } = require('../src/modules/universities/university.insights');

/** A student as produced by loadUniversityView (only the fields the pure helpers read). */
const stu = ({ m, ...rest } = {}) => ({
  collegeId: 'c1', departmentId: 'd1', admissionYear: 2023,
  m: { semesterCount: 1, held: 20, attendancePct: 90, activeBacklogs: 0, certCount: 2, hasTargetRole: true, verifiedGapPct: 20, academics: { trend: [{ semester: 1, sgpa: 8 }] }, ...m },
  risk: { band: 'low' }, placement: 70, attendedEvent: false, ...rest,
});
const weak = (o = {}) => stu({ m: { attendancePct: 50, activeBacklogs: 2, academics: { trend: [{ semester: 1, sgpa: 4 }] } }, risk: { band: 'high' }, ...o });

const view = (students) => ({
  colleges: [{ id: 'c1', name: 'Alpha', status: 'active' }, { id: 'c2', name: 'Beta', status: 'active' }, { id: 'c3', name: 'Gamma', status: 'pending' }],
  classes: [{ id: 'k1', collegeId: 'c1', status: 'active' }, { id: 'k2', collegeId: 'c2', status: 'active' }, { id: 'k3', collegeId: 'c2', status: 'suspended' }],
  departments: [{ id: 'd1', name: 'Computer Science', code: 'CSE', collegeId: 'c1' }, { id: 'd2', name: 'CS & Eng', code: 'CSE', collegeId: 'c2' }, { id: 'd3', name: 'Electronics', code: 'ECE', collegeId: 'c2' }, { id: 'd4', name: 'Law', code: 'LAW', collegeId: 'c3' }],
  students,
});
const pool = () => [stu(), stu(), stu({ collegeId: 'c2', departmentId: 'd2', admissionYear: 2022 }), weak({ collegeId: 'c2', departmentId: 'd3', admissionYear: 2022 }), weak({ collegeId: 'c2', departmentId: 'd3', admissionYear: 2024 })];

describe('rollUp', () => {
  it('summarises every college; a pending college is listed with no students and no score', () => {
    const r = rollUp(view(pool()));
    const by = Object.fromEntries(r.colleges.map((c) => [c.id, c]));
    assert.equal(by.c1.summary.students, 2); assert.equal(by.c2.summary.students, 3);
    assert.equal(by.c3.status, 'pending'); assert.equal(by.c3.summary.students, 0); assert.equal(by.c3.summary.score, null);
    assert.ok(by.c1.summary.score > by.c2.summary.score, 'the all-good college outscores the mixed one');
  });

  it('the university summary pools all students (student-weighted, not a mean of college scores)', () => {
    const r = rollUp(view(pool()));
    assert.equal(r.university.students, 5);
    assert.equal(r.university.metrics.attendancePct, 74, '(90+90+90+50+50)/5');
    assert.deepEqual(r.university.risk, { low: 3, medium: 0, high: 2, unknown: 0 });
  });

  it('counts departments and ACTIVE classes per college, and attaches the pending queue', () => {
    const r = rollUp(view(pool()), new Map([['c1', { total: 4, stale: 1 }]]));
    const c1 = r.colleges.find((c) => c.id === 'c1'); const c2 = r.colleges.find((c) => c.id === 'c2');
    assert.deepEqual([c1.departments, c1.classes, c2.departments, c2.classes], [1, 1, 2, 1], 'the suspended class k3 is not counted');
    assert.deepEqual(c1.pending, { total: 4, stale: 1 }); assert.deepEqual(c2.pending, { total: 0, stale: 0 });
  });

  it('departments of inactive colleges are left out; empty ones stay when nothing is filtered', () => {
    const r = rollUp(view(pool()));
    assert.deepEqual(r.departments.map((d) => d.id).sort(), ['d1', 'd2', 'd3']);
    assert.equal(r.departments.find((d) => d.id === 'd1').college, 'Alpha');
  });

  it('filters narrow the pool: by college, by department code (across colleges) and by admission year', () => {
    const v = view(pool());
    assert.equal(rollUp(v, new Map(), { collegeId: 'c2' }).university.students, 3);
    assert.equal(rollUp(v, new Map(), { departmentCode: 'CSE' }).university.students, 3, 'CSE exists in two colleges');
    assert.equal(rollUp(v, new Map(), { admissionYear: 2022 }).university.students, 2);
    const both = rollUp(v, new Map(), { collegeId: 'c2', departmentCode: 'ECE', admissionYear: 2022 });
    assert.equal(both.university.students, 1);
    assert.deepEqual(both.departments.map((d) => d.id), ['d3'], 'departments nobody belongs to are hidden while filtering');
  });

  it('cohorts are admission years in ascending order, with the number of colleges in each', () => {
    const r = rollUp(view(pool()));
    assert.deepEqual(r.cohorts.map((y) => [y.year, y.summary.students, y.colleges]), [[2022, 2, 1], [2023, 2, 1], [2024, 1, 1]]);
  });

  it('an empty university has no score and no cohorts', () => {
    const r = rollUp(view([]));
    assert.equal(r.university.score, null); assert.deepEqual(r.cohorts, []);
  });
});

describe('sgpaTrend', () => {
  it('averages each semester over the students who have it, ascending', () => {
    const t = sgpaTrend([
      stu({ m: { academics: { trend: [{ semester: 1, sgpa: 8 }, { semester: 2, sgpa: 9 }] } } }),
      stu({ m: { academics: { trend: [{ semester: 1, sgpa: 6 }] } } }),
    ]);
    assert.deepEqual(t, [{ semester: 1, avgSgpa: 7, students: 2 }, { semester: 2, avgSgpa: 9, students: 1 }]);
  });
  it('is empty without marks', () => assert.deepEqual(sgpaTrend([stu({ m: { academics: { trend: [] } } })]), []));
});

describe('buildUniversityInsights', () => {
  const comps = (o = {}) => ({ avgSgpa: 70, attendance: 70, passPct: 70, certificates: 70, placement: 70, skills: 70, events: 70, ...o });
  const col = (id, name, score, components = comps()) => ({ id, name, summary: { score, components } });
  const base = (o = {}) => ({
    university: { components: comps(), metrics: { eventParticipationPct: 50 } },
    colleges: [col('1', 'Alpha', 80), col('2', 'Beta', 60)], collegeAlerts: [], pending: { total: 0, stale: 0 },
    pendingColleges: 0, suspendedColleges: 0, emptyColleges: [], ...o,
  });
  const ids = (d) => buildUniversityInsights(d).map((i) => i.id);

  it('says everything is fine for a single healthy college', () => assert.deepEqual(ids(base({ colleges: [col('1', 'Alpha', 80)] })), ['all_good']));
  it('ranks colleges: best leads, worst is cited with the gap', () => {
    const i = buildUniversityInsights(base()).find((x) => x.id === 'top_college');
    assert.match(i.title, /Alpha leads with 80/); assert.match(i.detail, /Beta is lowest at 60 — a 20-point gap/);
  });
  it('pending and suspended colleges are reported with correct grammar', () => {
    const r = buildUniversityInsights(base({ pendingColleges: 1, suspendedColleges: 2 }));
    assert.match(r.find((x) => x.id === 'colleges_pending').title, /^1 college waiting/);
    assert.match(r.find((x) => x.id === 'colleges_suspended').title, /^2 colleges are suspended/);
    assert.equal(r.find((x) => x.id === 'colleges_pending').severity, 'warning');
  });
  it('stale verifications are critical; flagged colleges name their first reason', () => {
    const r = buildUniversityInsights(base({ pending: { total: 3, stale: 3 }, collegeAlerts: [{ name: 'Beta', reasons: ['Average attendance 60%'] }] }));
    assert.equal(r.find((x) => x.id === 'stale_verifications').severity, 'critical');
    assert.match(r.find((x) => x.id === 'college_alerts').detail, /Beta: Average attendance 60%/);
    assert.equal(r.find((x) => x.id === 'college_alerts').title, '1 college needs attention');
    const two = buildUniversityInsights(base({ collegeAlerts: [{ name: 'A', reasons: ['x'] }, { name: 'B', reasons: ['y'] }] }));
    assert.equal(two.find((x) => x.id === 'college_alerts').title, '2 colleges need attention');
  });
  it('flags a college more than 10 points behind the university and links to its page', () => {
    const r = buildUniversityInsights(base({ colleges: [col('1', 'Alpha', 80), col('2', 'Beta', 60, comps({ attendance: 40 }))] }));
    const lag = r.find((x) => x.id === 'lag_2');
    assert.match(lag.title, /Beta is behind the university on attendance/); assert.equal(lag.to, '/university/colleges/2');
  });
  it('low event participation and colleges without classes are reported', () => {
    const r = ids(base({ university: { components: comps(), metrics: { eventParticipationPct: 10 } }, emptyColleges: ['Gamma'] }));
    assert.ok(r.includes('low_events') && r.includes('empty_colleges'));
  });
});
