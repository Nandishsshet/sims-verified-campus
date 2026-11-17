'use strict';
/** Pure college roll-up logic (no database): summarise, rankGroups, behindCollege, classAlert, alertSeverity, buildInsights. */
require('./helpers/env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarise, rankGroups, behindCollege, classAlert, alertSeverity, buildInsights, STALE_DAYS } = require('../src/modules/colleges/college.insights');

/** A student as produced by loadCollegeView (only the fields the pure helpers read). */
const stu = ({ m, ...rest } = {}) => ({
  m: {
    semesterCount: 1, held: 20, attendancePct: 90, activeBacklogs: 0, certCount: 2, hasTargetRole: true, verifiedGapPct: 20,
    academics: { trend: [{ semester: 1, sgpa: 8 }] }, ...m,
  },
  risk: { band: 'low' }, placement: 70, attendedEvent: false, ...rest,
});
const noData = () => stu({ m: { semesterCount: 0, held: 0, attendancePct: 0, certCount: 0, hasTargetRole: false, academics: { trend: [] } }, risk: { band: 'unknown' }, placement: 0 });

describe('summarise', () => {
  it('an empty group has no metrics and no score', () => {
    const s = summarise([]);
    assert.equal(s.students, 0); assert.equal(s.metrics, null); assert.equal(s.score, null); assert.equal(s.hasData, false);
  });

  it('a group with students but no verified marks or attendance is "no data", not a failure', () => {
    const s = summarise([noData(), noData()]);
    assert.equal(s.hasData, false); assert.equal(s.score, null); assert.deepEqual(s.coverage, { withMarks: 0, withAttendance: 0, withTargetRole: 0 });
    assert.equal(s.metrics.skillGapPct, 100, 'no target roles → the worst gap');
    assert.deepEqual(s.risk, { low: 0, medium: 0, high: 0, unknown: 2 });
  });

  it('averages only over students that have the data; pass % over students with marks', () => {
    const s = summarise([
      stu({ m: { attendancePct: 100, academics: { trend: [{ semester: 1, sgpa: 6 }, { semester: 2, sgpa: 9 }] } } }),
      stu({ m: { attendancePct: 60, activeBacklogs: 2, academics: { trend: [{ semester: 1, sgpa: 5 }] } }, risk: { band: 'high' } }),
      noData(),
    ]);
    assert.equal(s.students, 3); assert.equal(s.coverage.withMarks, 2); assert.equal(s.coverage.withAttendance, 2);
    assert.equal(s.metrics.avgSgpa, 7, 'mean of the LATEST sgpa (9 and 5)');
    assert.equal(s.metrics.attendancePct, 80, 'the student with no attendance is not counted as 0 here');
    assert.equal(s.metrics.passPct, 50);
    assert.equal(s.metrics.certsPerStudent, 1.33, 'certificates are averaged over all students');
    assert.equal(s.metrics.eventParticipationPct, 0);
    assert.deepEqual(s.risk, { low: 1, medium: 0, high: 1, unknown: 1 });
    assert.ok(s.score > 0 && s.score < 100);
  });

  it('event participation is the share of ALL students who attended something', () => {
    const s = summarise([stu({ attendedEvent: true }), stu(), stu(), stu()]);
    assert.equal(s.metrics.eventParticipationPct, 25);
  });

  it('a better group scores higher and has fewer weak metrics', () => {
    const good = summarise([stu({ m: { attendancePct: 95 }, attendedEvent: true }), stu({ m: { attendancePct: 92 }, attendedEvent: true })]);
    const bad = summarise([stu({ m: { attendancePct: 40, activeBacklogs: 3, academics: { trend: [{ semester: 1, sgpa: 4 }] } }, risk: { band: 'high' } })]);
    assert.ok(good.score > bad.score);
    assert.ok(bad.weak.includes('attendance') && bad.weak.includes('passPct'));
    assert.ok(!good.weak.includes('attendance'));
  });
});

describe('rankGroups', () => {
  it('orders by score, shares ranks on ties, and puts groups without a score last and unranked', () => {
    const r = rankGroups([{ name: 'D', score: null }, { name: 'B', score: 70 }, { name: 'A', score: 80 }, { name: 'C', score: 70 }]);
    assert.deepEqual(r.map((x) => x.name), ['A', 'B', 'C', 'D']);
    assert.deepEqual(r.map((x) => x.rank), [1, 2, 2, null]);
  });
  it('the next rank after a tie skips (1, 1, 3)', () => {
    assert.deepEqual(rankGroups([{ name: 'a', score: 9 }, { name: 'b', score: 9 }, { name: 'c', score: 5 }]).map((x) => x.rank), [1, 1, 3]);
  });
  it('does not mutate its input and copes with an empty list', () => {
    const input = [{ name: 'b', score: 1 }, { name: 'a', score: 2 }];
    rankGroups(input); assert.equal(input[0].name, 'b');
    assert.deepEqual(rankGroups([]), []);
  });
});

describe('behindCollege', () => {
  const college = { components: { attendance: 80, avgSgpa: 70, passPct: 90 } };
  it('lists components more than the gap below the college mean', () => {
    assert.deepEqual(behindCollege({ components: { attendance: 60, avgSgpa: 65, passPct: 100 } }, college), ['attendance']);
  });
  it('exactly 10 points below is not "behind"', () => {
    assert.deepEqual(behindCollege({ components: { attendance: 70, avgSgpa: 70, passPct: 90 } }, college), []);
    assert.deepEqual(behindCollege({ components: { attendance: 70, avgSgpa: 70, passPct: 90 } }, college, 5), ['attendance']);
  });
  it('is empty when either side has no components', () => {
    assert.deepEqual(behindCollege({ components: null }, college), []);
    assert.deepEqual(behindCollege({ components: { attendance: 1 } }, { components: null }), []);
  });
});

describe('classAlert / alertSeverity', () => {
  const sum = (over = {}) => ({ students: 10, hasData: true, metrics: { attendancePct: 85, passPct: 90 }, risk: { low: 9, medium: 1, high: 0, unknown: 0 }, ...over });

  it('a healthy class has no reasons', () => assert.deepEqual(classAlert({ summary: sum(), pendingStale: 0, pendingTotal: 0 }), []));
  it('an empty class is never an alert', () => assert.deepEqual(classAlert({ summary: sum({ students: 0 }), pendingStale: 5, pendingTotal: 5 }), []));
  it('no verified data is itself a reason', () => {
    const r = classAlert({ summary: sum({ hasData: false, metrics: {} }), pendingStale: 0, pendingTotal: 0 });
    assert.equal(r.length, 1); assert.match(r[0], /No verified/);
  });
  it('low attendance, risk concentration, backlogs and stale verifications each add a reason', () => {
    const r = classAlert({
      summary: sum({ metrics: { attendancePct: 60, passPct: 50 }, risk: { low: 5, medium: 3, high: 2, unknown: 0 } }), pendingStale: 2, pendingTotal: 3,
    });
    assert.equal(r.length, 4);
    assert.ok(r.some((x) => /attendance 60%/i.test(x)) && r.some((x) => /5 of 10/.test(x)) && r.some((x) => /50%/.test(x)) && r.some((x) => new RegExp(`2 verifications waiting more than ${STALE_DAYS} days`).test(x)));
  });
  it('risk share ignores students whose risk is unknown; exactly 30 % triggers', () => {
    assert.equal(classAlert({ summary: sum({ risk: { low: 7, medium: 3, high: 0, unknown: 0 } }), pendingStale: 0 }).length, 1);
    assert.equal(classAlert({ summary: sum({ risk: { low: 2, medium: 1, high: 0, unknown: 7 } }), pendingStale: 0 }).length, 1, '1 of 3 judged');
    assert.equal(classAlert({ summary: sum({ risk: { low: 2, medium: 0, high: 0, unknown: 8 } }), pendingStale: 0 }).length, 0);
  });
  it('singular wording for one stale item', () => {
    assert.match(classAlert({ summary: sum(), pendingStale: 1 })[0], /1 verification waiting/);
  });
  it('severity: critical with two reasons or attendance under 65 %, otherwise warning', () => {
    assert.equal(alertSeverity(['a'], sum()), 'warning');
    assert.equal(alertSeverity(['a', 'b'], sum()), 'critical');
    assert.equal(alertSeverity(['a'], sum({ metrics: { attendancePct: 64 } })), 'critical');
    assert.equal(alertSeverity(['a'], { metrics: null }), 'warning');
  });
});

describe('buildInsights', () => {
  const comps = (o = {}) => ({ avgSgpa: 70, attendance: 70, passPct: 70, certificates: 70, placement: 70, skills: 70, events: 70, ...o });
  const dep = (id, name, score, components = comps()) => ({ id, name, summary: { score, components } });
  const base = (o = {}) => ({
    college: { components: comps(), metrics: { eventParticipationPct: 50 } },
    departments: [dep('1', 'CSE', 80), dep('2', 'ECE', 60)], classAlerts: [], pendingInstructors: 0,
    pending: { total: 0, stale: 0 }, emptyDepartments: [], ...o,
  });
  const ids = (d) => buildInsights(d).map((i) => i.id);

  it('says everything is fine when nothing fires (single department → no ranking insight)', () => {
    assert.deepEqual(ids(base({ departments: [dep('1', 'CSE', 80)] })), ['all_good']);
  });
  it('ranks departments: best leads, worst is cited with the gap', () => {
    const i = buildInsights(base()).find((x) => x.id === 'top_department');
    assert.equal(i.severity, 'positive'); assert.match(i.title, /CSE leads with 80/); assert.match(i.detail, /ECE is lowest at 60 — a 20-point gap/);
  });
  it('stale verifications are critical and replace the "pending" info line', () => {
    const r = buildInsights(base({ pending: { total: 4, stale: 2 } }));
    assert.equal(r.find((x) => x.id === 'stale_verifications').severity, 'critical');
    assert.ok(!r.some((x) => x.id === 'pending_verifications'));
    assert.ok(ids(base({ pending: { total: 4, stale: 0 } })).includes('pending_verifications'));
  });
  it('pending instructors, class alerts and empty departments are reported', () => {
    const r = ids(base({ pendingInstructors: 2, classAlerts: [{ name: 'ECE 2023', reasons: ['Average attendance 50%'] }], emptyDepartments: ['Civil'] }));
    for (const id of ['instructors_pending', 'class_alerts', 'empty_departments']) assert.ok(r.includes(id), id);
    assert.ok(!r.includes('all_good'));
  });
  it('flags a department more than 10 points behind the college and names the metric', () => {
    const r = buildInsights(base({ departments: [dep('1', 'CSE', 80), dep('2', 'ECE', 60, comps({ attendance: 40 }))] }));
    const lag = r.find((x) => x.id === 'lag_2');
    assert.match(lag.title, /ECE is behind the college on attendance/); assert.match(lag.detail, /40 vs a college average of 70/);
    assert.ok(!r.some((x) => x.id === 'lag_1'));
  });
  it('low event participation is flagged below 30 %', () => {
    assert.ok(ids(base({ college: { components: comps(), metrics: { eventParticipationPct: 10 } } })).includes('low_events'));
    assert.ok(!ids(base()).includes('low_events'));
  });
  it('departments without a score are ignored by the ranking', () => {
    assert.ok(!ids(base({ departments: [dep('1', 'CSE', 80), dep('2', 'ECE', null, null)] })).includes('top_department'));
  });
});
