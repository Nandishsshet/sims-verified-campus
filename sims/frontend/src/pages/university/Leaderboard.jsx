import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, Select, num, useLoad } from '../../ui';
import { Tabs } from '../class/shared';
import { METRICS, RankBadge, ScoreText } from '../college/shared';

const th = 'px-3 py-3 text-right';

/** Colleges, ranked by the department-score formula applied to everyone in the college. */
function CollegesTab() {
  const q = useLoad(() => api.get('/university/leaderboard/colleges'));
  return (
    <Async state={q}>{({ board, university }) => board.length === 0 ? <Empty title="No active college yet" /> : (
      <Card pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">College</th><th className={th}>Students</th><th className={th}>Attendance</th><th className={th}>SGPA</th><th className="px-3 py-3">Weak areas</th><th className="px-3 py-3">Behind university</th><th className="px-4 py-3 text-right">Score</th></tr></thead>
            <tbody className="divide-y divide-line">
              {board.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2/60">
                  <td className="px-4 py-3"><RankBadge rank={r.rank} /></td>
                  <td className="px-4 py-3"><Link to={`/university/colleges/${r.id}`} className="font-medium hover:text-brand">{r.name}</Link><div className="text-xs text-muted">{r.departments} dept{r.departments === 1 ? '' : 's'} · {r.classes} class{r.classes === 1 ? '' : 'es'}</div></td>
                  <td className={`${th} tabular-nums`}>{r.students}</td>
                  <td className={`${th} tabular-nums`}>{r.metrics ? `${num(r.metrics.attendancePct)}%` : '—'}</td>
                  <td className={`${th} tabular-nums`}>{r.metrics ? num(r.metrics.avgSgpa, 2) : '—'}</td>
                  <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{r.weak.length ? r.weak.map((k) => <Pill key={k} tone="bad">{METRICS[k]}</Pill>) : <span className="text-muted">—</span>}</div></td>
                  <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{r.behind.length ? r.behind.map((k) => <Pill key={k} tone="warn">{METRICS[k]}</Pill>) : <span className="text-muted">—</span>}</div></td>
                  <td className="px-4 py-3 text-right"><ScoreText score={r.score} className="text-base" /></td>
                </tr>
              ))}
              <tr className="bg-surface-2/60 font-medium"><td className="px-4 py-3" /><td className="px-4 py-3" colSpan={6}>University overall</td><td className="px-4 py-3 text-right"><ScoreText score={university.score} className="text-base" /></td></tr>
            </tbody>
          </table>
        </div>
      </Card>
    )}</Async>
  );
}

/** Every department of every active college; filter by department code to compare, say, all the CSE departments. */
function DepartmentsTab() {
  const [code, setCode] = useState('');
  const codes = useLoad(() => api.get('/university/analytics'));        // only for the list of codes
  const q = useLoad(() => api.get(`/university/best-departments?limit=100${code ? `&code=${encodeURIComponent(code)}` : ''}`), [code]);
  return (
    <>
      <div className="mb-4"><Select aria-label="Department code" className="!w-auto" value={code} onChange={(e) => setCode(e.target.value)}><option value="">All departments</option>{codes.data?.filters.options.departmentCodes.map((c) => <option key={c} value={c}>{c} across colleges</option>)}</Select></div>
      <Async state={q}>{({ board }) => board.length === 0 ? <Empty title="No departments match" /> : (
        <Card pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">College</th><th className={th}>Students</th><th className={th}>Attendance</th><th className="px-3 py-3">Weak areas</th><th className="px-4 py-3 text-right">Score</th></tr></thead>
              <tbody className="divide-y divide-line">
                {board.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-2/60">
                    <td className="px-4 py-3"><RankBadge rank={r.rank} /></td>
                    <td className="px-4 py-3"><span className="font-medium">{r.name}</span> <span className="text-xs text-muted">{r.code}</span></td>
                    <td className="px-4 py-3"><Link to={`/university/colleges/${r.collegeId}`} className="hover:text-brand">{r.college}</Link></td>
                    <td className={`${th} tabular-nums`}>{r.students}</td>
                    <td className={`${th} tabular-nums`}>{r.metrics ? `${num(r.metrics.attendancePct)}%` : '—'}</td>
                    <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{r.weak.length ? r.weak.map((k) => <Pill key={k} tone="bad">{METRICS[k]}</Pill>) : <span className="text-muted">—</span>}</div></td>
                    <td className="px-4 py-3 text-right"><ScoreText score={r.score} className="text-base" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}</Async>
    </>
  );
}

/**
 * Top students university-wide. Deliberately limited to name, college, department and score: the head sees
 * who is doing well, not anyone's contact details or roll number. Everyone is scored with the standard
 * weights so students of different colleges are comparable.
 */
function StudentsTab() {
  const [collegeId, setCollegeId] = useState('');
  const [limit, setLimit] = useState(25);
  const colleges = useLoad(() => api.get('/university/leaderboard/colleges'));
  const q = useLoad(() => api.get(`/university/top-students?limit=${limit}${collegeId ? `&collegeId=${collegeId}` : ''}`), [collegeId, limit]);
  const LABEL = { marks: 'Marks', attendance: 'Attendance', certificates: 'Certificates', skills: 'Skills', resume: 'Resume', activity: 'Activities' };
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="College" className="!w-auto" value={collegeId} onChange={(e) => setCollegeId(e.target.value)}><option value="">All colleges</option>{colleges.data?.board.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="How many" className="!w-auto" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[10, 25, 50, 100].map((n) => <option key={n} value={n}>Top {n}</option>)}</Select>
      </div>
      <Async state={q}>{({ board, total, weights }) => (
        <>
          <p className="mb-3 text-sm text-muted">Standard weights: {Object.keys(LABEL).map((k) => `${LABEL[k]} ${weights[k]}%`).join(' · ')}. {total} ranked student{total === 1 ? '' : 's'}. Colleges and classes may use their own weights locally; here everyone is compared on the same scale.</p>
          {board.length === 0 ? <Empty title="No ranked students yet">Students are ranked once their class is active and an instructor verifies their data.</Empty> : (
            <Card pad={false}>
              <ul className="divide-y divide-line">{board.map((s) => (
                <li key={`${s.rank}${s.name}${s.college}`} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <RankBadge rank={s.rank} /><div className="min-w-0 flex-1"><div className="font-medium">{s.name}</div><div className="truncate text-xs text-muted">{s.department} · {s.college}</div></div><b className="tabular-nums">{num(s.score)}</b>
                </li>
              ))}</ul>
            </Card>
          )}
        </>
      )}</Async>
    </>
  );
}

export default function Leaderboard() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'colleges';
  return (
    <>
      <PageHeader title="Leaderboards" subtitle="Colleges, departments and students ranked on verified data only." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'colleges', label: 'Colleges' }, { id: 'departments', label: 'Departments' }, { id: 'students', label: 'Students' }]} />
      {tab === 'departments' ? <DepartmentsTab /> : tab === 'students' ? <StudentsTab /> : <CollegesTab />}
    </>
  );
}
