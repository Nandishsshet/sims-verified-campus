'use strict';
/** Pure logic of Phase 4: the CSV reader/writer and the class-level risk / bucket helpers. No database needed. */
require('./helpers/env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../src/utils/csv');
const { riskOf, bucketise, avg } = require('../src/modules/classes/class.insights');

describe('csv.parse', () => {
  it('reads quoted fields, escaped quotes, embedded commas/newlines, CRLF and a BOM', () => {
    const text = '﻿Roll Number,Subject-Code,note\r\nR1,CS101,"a, b"\r\nR2,CS102,"say ""hi""\nsecond line"\r\n';
    const { headers, records } = csv.parse(text);
    assert.deepEqual(headers, ['roll_number', 'subject_code', 'note']);
    assert.equal(records.length, 2);
    assert.equal(records[0].values.note, 'a, b');
    assert.equal(records[1].values.note, 'say "hi"\nsecond line');
  });

  it('reports 1-based file line numbers (header = line 1) and skips blank lines', () => {
    const { records } = csv.parse('a,b\n1,2\n\n3,4\n');
    assert.deepEqual(records.map((r) => r.line), [2, 4]);
  });

  it('trims cells, tolerates short rows, and rejects an unterminated quote', () => {
    assert.equal(csv.parse('a,b\n  x  \n').records[0].values.b, '');
    assert.throws(() => csv.parse('a,b\n"oops,1\n'), /Unterminated quote/);
  });

  it('handles an empty file', () => {
    assert.deepEqual(csv.parse(''), { headers: [], records: [] });
  });
});

describe('csv.toCsv', () => {
  it('quotes when needed and round-trips through parse', () => {
    const out = csv.toCsv(['name', 'note'], [['Ann, B', 'say "x"'], ['C', 'line1\nline2']]);
    const back = csv.parse(out);
    assert.equal(back.records[0].values.name, 'Ann, B');
    assert.equal(back.records[0].values.note, 'say "x"');
    assert.equal(back.records[1].values.note, 'line1\nline2');
  });

  it('neutralises spreadsheet formula injection', () => {
    const out = csv.toCsv(['n'], [['=HYPERLINK("http://evil")'], ['+1+1'], ['-2+3'], ['@SUM(A1)'], ['safe']]);
    const cells = csv.parseRows(out).slice(1).map((r) => r[0]);
    assert.ok(cells.slice(0, 4).every((c) => c.startsWith("'")), cells.join(' | '));
    assert.equal(cells[4], 'safe');
  });
});

describe('class insights', () => {
  const metrics = (over = {}) => ({ held: 40, attendancePct: 90, activeBacklogs: 0, activityScore: 50, academics: { trend: [{ semester: 1, sgpa: 8, cgpa: 8 }, { semester: 2, sgpa: 8.2, cgpa: 8.1 }] }, ...over });

  it('a healthy student is low risk with no reasons', () => {
    const r = riskOf(metrics());
    assert.equal(r.band, 'low'); assert.deepEqual(r.reasons, []);
  });

  it('flags low attendance, backlogs and an SGPA fall with readable reasons', () => {
    const r = riskOf(metrics({ attendancePct: 55, activeBacklogs: 2, academics: { trend: [{ semester: 1, sgpa: 7.5, cgpa: 7.5 }, { semester: 2, sgpa: 6.5, cgpa: 7 }] } }));
    assert.ok(['medium', 'high'].includes(r.band));
    assert.ok(r.reasons.some((x) => x.includes('55%')));
    assert.ok(r.reasons.some((x) => x.includes('2 active backlogs')));
    assert.ok(r.reasons.some((x) => x.includes('fell by 1')));
  });

  it('with no verified data at all the band is "unknown", never "high"', () => {
    const r = riskOf(metrics({ held: 0, attendancePct: 0, academics: { trend: [] } }));
    assert.equal(r.band, 'unknown'); assert.equal(r.score, null);
  });

  it('missing attendance alone is not treated as 0% attendance', () => {
    const r = riskOf(metrics({ held: 0, attendancePct: 0 }));
    assert.notEqual(r.band, 'high');
    assert.ok(!r.reasons.some((x) => x.toLowerCase().includes('attendance')));
  });

  it('bucketise puts boundary values in the upper bucket', () => {
    const b = bucketise([10, 59, 60, 74, 75, 84, 85, 100], [60, 75, 85], (x) => `${x}%`);
    assert.deepEqual(b.map((x) => x.count), [2, 2, 2, 2]);
    assert.deepEqual(b.map((x) => x.label), ['<60%', '60%–75%', '75%–85%', '85%+']);
  });

  it('avg ignores nothing and returns null for an empty list', () => {
    assert.equal(avg([]), null);
    assert.equal(avg([7, 8, 9]), 8);
  });
});
