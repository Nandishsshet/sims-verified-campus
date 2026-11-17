'use strict';
/**
 * Pure academic maths on top of scoring.js: grade derivation for one mark row, and
 * semester / cumulative results from a student's VERIFIED mark rows.
 */
const scoring = require('./scoring');

const GRADE_LETTERS = { 10: 'O', 9: 'A+', 8: 'A', 7: 'B+', 6: 'B', 5: 'C', 4: 'P', 0: 'F' };
const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);

/** Derive total, grade, grade points and pass/fail for one subject attempt. */
function deriveMark({ internalObtained, internalMax = 40, externalObtained, externalMax = 60 }) {
  const total = internalObtained + externalObtained;
  const max = internalMax + externalMax;
  const percentage = max > 0 ? (total / max) * 100 : 0;
  const pass = scoring.isPass({ internalObtained, internalMax, externalObtained, externalMax });
  const gradePoints = pass ? scoring.gradePoints(percentage) : 0;
  return { total, max, percentage: scoring.round(percentage), pass, gradePoints, grade: pass ? GRADE_LETTERS[gradePoints] : 'F' };
}

/**
 * @param rows verified mark rows: { subject_id, semester, attempt, grade_points, is_pass, credits, code, name, ... }
 * Only the LATEST attempt per subject counts, so a cleared backlog replaces the failed
 * attempt in its semester's SGPA and in the CGPA.
 */
function computeAcademics(rows) {
  const latest = new Map();
  for (const r of rows) {
    const cur = latest.get(r.subject_id);
    if (!cur || r.attempt > cur.attempt) latest.set(r.subject_id, r);
  }
  const bySemester = new Map();
  for (const r of latest.values()) {
    if (!bySemester.has(r.semester)) bySemester.set(r.semester, []);
    bySemester.get(r.semester).push(r);
  }

  const semesters = [...bySemester.keys()].sort((a, b) => a - b).map((semester) => {
    const subjects = bySemester.get(semester);
    const credits = sum(subjects, (s) => Number(s.credits));
    return {
      semester,
      credits,
      creditsEarned: sum(subjects.filter((s) => s.is_pass), (s) => Number(s.credits)),
      sgpa: scoring.sgpa(subjects.map((s) => ({ credits: Number(s.credits), gradePoints: s.is_pass ? Number(s.grade_points) : 0 }))),
      backlogCount: subjects.filter((s) => !s.is_pass).length,
      subjects,
    };
  });

  const trend = semesters.map((s, i) => ({
    semester: s.semester,
    sgpa: s.sgpa,
    cgpa: scoring.cgpa(semesters.slice(0, i + 1).map((x) => ({ credits: x.credits, sgpa: x.sgpa }))),
  }));

  return {
    semesters,
    trend,
    cgpa: trend.length ? trend[trend.length - 1].cgpa : 0,
    creditsDone: sum(semesters, (s) => s.credits),
    activeBacklogs: semesters.flatMap((s) => s.subjects.filter((x) => !x.is_pass)),
  };
}

module.exports = { GRADE_LETTERS, deriveMark, computeAcademics };
