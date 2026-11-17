import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, Progress, Select, num, useLoad } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { RiskPill, Tabs, pctTone } from './shared';

const COMPARE_COLORS = ['var(--brand)', 'var(--good)', 'var(--warn)', 'var(--info)'];
const COMPONENTS = ['marks', 'attendance', 'certificates', 'skills', 'resume', 'activity'];

function SubjectsTab() {
  const { url, current } = useClass();
  const [sem, setSem] = useState(current.current_semester);
  const q = useLoad(() => api.get(url(`/analytics/subjects?semester=${sem}`)), [current.id, sem]);
  const p = useLoad(() => api.get(url('/analytics/performers?n=5')), [current.id]);
  return (
    <div className="space-y-6">
      <Card title="Subject performance" action={<Select aria-label="Semester" className="!w-auto" value={sem} onChange={(e) => setSem(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1}</option>)}</Select>}>
        <Async state={q}>{({ subjects }) => subjects.length === 0 ? <Empty title="No subjects in this semester" /> : subjects.every((s) => s.students === 0) ? <Empty title="No verified marks for this semester yet" /> : (
          <>
            <div className="h-64" role="img" aria-label="Average percentage and pass rate per subject">
              <ResponsiveContainer>
                <BarChart data={subjects} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="code" tickLine={false} axisLine={false} />
                  <YAxis domain={[0, 100]} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v, n) => [v == null ? '—' : `${num(v)}%`, n]} />
                  <Legend />
                  <Bar dataKey="avgPercentage" name="Average mark" fill="var(--brand)" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="passPct" name="Pass rate" fill="var(--good)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 pr-4">Subject</th><th className="py-2 pr-4 text-right">Students</th><th className="py-2 pr-4 text-right">Average</th><th className="py-2 pr-4 text-right">Best</th><th className="py-2 pr-4 text-right">Pass rate</th><th className="py-2 text-right">Attendance</th></tr></thead>
                <tbody className="divide-y divide-line">{subjects.map((s) => (
                  <tr key={s.id}><td className="py-2.5 pr-4"><span className="font-medium">{s.code}</span> <span className="text-muted">{s.name}</span></td><td className="py-2.5 pr-4 text-right tabular-nums">{s.students}</td><td className="py-2.5 pr-4 text-right tabular-nums">{s.avgPercentage != null ? `${num(s.avgPercentage)}%` : '—'}</td><td className="py-2.5 pr-4 text-right tabular-nums">{s.bestPercentage != null ? `${num(s.bestPercentage)}%` : '—'}</td><td className={`py-2.5 pr-4 text-right tabular-nums ${pctTone(s.passPct, 85, 60)}`}>{s.passPct != null ? `${num(s.passPct)}%` : '—'}</td><td className={`py-2.5 text-right tabular-nums ${pctTone(s.attendancePct)}`}>{s.attendancePct != null ? `${num(s.attendancePct)}%` : '—'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}</Async>
      </Card>
      <Async state={p}>{({ top, bottom, noData }) => (
        <div className="grid gap-6 md:grid-cols-2">
          {[['Top performers', top], ['Needs support', bottom]].map(([title, list]) => (
            <Card key={title} title={title} pad={false}>
              {list.length === 0 ? <p className="p-5 text-sm text-muted">{title === 'Needs support' ? 'Not enough students with data to separate a bottom group.' : 'No ranked students yet.'}</p> : (
                <ul className="divide-y divide-line">{list.map((s) => <li key={s.id} className="flex items-center justify-between px-5 py-3 text-sm"><span><Link to={`/class/students/${s.id}`} className="font-medium hover:text-brand">{s.name}</Link> <span className="text-xs text-muted">#{s.rank} · CGPA {num(s.cgpa, 2)}</span></span><b className="tabular-nums">{num(s.score)}</b></li>)}</ul>
              )}
              {title === 'Needs support' && noData > 0 && <p className="border-t border-line px-5 py-2.5 text-xs text-muted">{noData} student{noData === 1 ? ' has' : 's have'} no verified data yet and {noData === 1 ? 'is' : 'are'} not ranked here.</p>}
            </Card>
          ))}
        </div>
      )}</Async>
    </div>
  );
}

function RiskTab() {
  const { url, current } = useClass();
  const q = useLoad(() => api.get(url('/analytics/at-risk')), [current.id]);
  return (
    <Async state={q}>{({ students, threshold }) => students.length === 0 ? <Empty title="Nobody is flagged 🎉">Students show up here when their verified attendance is below {threshold}%, they have active backlogs or their latest SGPA is below 5.</Empty> : (
      <Card pad={false}>
        <ul className="divide-y divide-line">{students.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <Link to={`/class/students/${s.id}`} className="font-medium hover:text-brand">{s.name}</Link> <span className="text-xs text-muted">{s.rollNumber}</span>
              <ul className="mt-1 flex flex-wrap gap-1.5">{s.reasons.map((r) => <li key={r}><Pill tone="warn">{r}</Pill></li>)}</ul>
            </div>
            <div className="flex items-center gap-4 text-sm tabular-nums"><span className={pctTone(s.attendancePct)}>{s.attendancePct != null ? `${num(s.attendancePct)}%` : '—'}</span><span>CGPA {num(s.cgpa, 2)}</span><RiskPill band={s.band} /></div>
          </li>
        ))}</ul>
      </Card>
    )}</Async>
  );
}

function SkillTab() {
  const { url, current } = useClass();
  const q = useLoad(() => api.get(url('/analytics/skill-gap')), [current.id]);
  return (
    <Async state={q}>{({ roles, withoutTarget }) => (
      <>
        {withoutTarget > 0 && <p className="mb-4 text-sm text-muted">{withoutTarget} student{withoutTarget === 1 ? ' has' : 's have'} not chosen a target role yet.</p>}
        {roles.length === 0 ? <Empty title="No target roles chosen">Students pick a career target in their Skill gap page. Gaps are measured against <b>verified</b> skills only.</Empty> : (
          <div className="grid gap-6 md:grid-cols-2">
            {roles.map((r) => (
              <Card key={r.roleId} title={r.role} action={<Pill tone="brand">{r.students} student{r.students === 1 ? '' : 's'}</Pill>}>
                <div className="mb-1 flex justify-between text-xs"><span className="text-muted">Average verified skill gap</span><b className="tabular-nums">{r.avgVerifiedGapPct != null ? `${num(r.avgVerifiedGapPct, 0)}%` : '—'}</b></div>
                <Progress value={r.avgVerifiedGapPct ?? 0} tone="warn" label="Average gap" />
                <div className="mb-1.5 mt-5 text-xs font-medium uppercase tracking-wide text-muted">Most often missing</div>
                {r.mostMissing.length === 0 ? <p className="text-sm text-muted">No common gaps.</p> : <ul className="space-y-1.5 text-sm">{r.mostMissing.map((m) => <li key={m.skill} className="flex justify-between"><span>{m.skill}</span><span className="tabular-nums text-muted">{m.lacking} of {m.of}</span></li>)}</ul>}
              </Card>
            ))}
          </div>
        )}
      </>
    )}</Async>
  );
}

function CompareTab() {
  const { url, current } = useClass();
  const roster = useLoad(() => api.get(url('/students')), [current.id]);
  const [ids, setIds] = useState([]);
  const cmp = useLoad(() => (ids.length >= 2 ? api.get(url(`/compare?studentIds=${ids.join(',')}`)) : Promise.resolve(null)), [current.id, ids.join(',')]);
  useEffect(() => { setIds([]); }, [current.id]);
  const toggle = (id) => setIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : l.length >= 4 ? l : [...l, id]));

  const radar = cmp.data && COMPONENTS.map((c) => ({ axis: c[0].toUpperCase() + c.slice(1), ...Object.fromEntries(cmp.data.students.map((s) => [s.id, Math.round(s.components[c] ?? 0)])) }));
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title={`Pick 2–4 students (${ids.length})`} pad={false} className="max-h-[32rem] overflow-y-auto">
        <Async state={roster}>{({ students }) => students.length < 2 ? <p className="p-5 text-sm text-muted">You need at least two students.</p> : (
          <ul className="divide-y divide-line">{students.map((s) => (
            <li key={s.id}><label className="flex cursor-pointer items-center gap-3 px-5 py-2.5 text-sm hover:bg-surface-2"><input type="checkbox" checked={ids.includes(s.id)} disabled={!ids.includes(s.id) && ids.length >= 4} onChange={() => toggle(s.id)} /><span className="min-w-0 flex-1 truncate">{s.name}</span><span className="text-xs text-muted">{s.rollNumber}</span></label></li>
          ))}</ul>
        )}</Async>
      </Card>
      <div className="space-y-6 lg:col-span-2">
        {ids.length < 2 ? <Empty title="Choose at least two students" /> : (
          <Async state={cmp}>{(d) => d && (
            <>
              <Card title="Score components">
                <div className="h-72" role="img" aria-label="Radar chart comparing score components">
                  <ResponsiveContainer>
                    <RadarChart data={radar}><PolarGrid /><PolarAngleAxis dataKey="axis" /><PolarRadiusAxis angle={60} domain={[0, 100]} tick={{ fontSize: 10 }} />
                      {d.students.map((s, i) => <Radar key={s.id} name={s.name} dataKey={s.id} stroke={COMPARE_COLORS[i]} fill={COMPARE_COLORS[i]} fillOpacity={0.15} />)}
                      <Legend /><Tooltip /></RadarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card pad={false}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-left text-sm">
                    <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3" />{d.students.map((s) => <th key={s.id} className="px-4 py-3 normal-case text-ink">{s.name}</th>)}</tr></thead>
                    <tbody className="divide-y divide-line">
                      {[['Rank', (s) => `#${s.rank}`], ['Score', (s) => num(s.score)], ['CGPA', (s) => num(s.cgpa, 2)], ['Attendance', (s) => (s.attendancePct != null ? `${num(s.attendancePct)}%` : '—')], ['Backlogs', (s) => s.backlogs],
                        ['Certificates', (s) => s.certificates], ['Projects', (s) => s.projects], ['Placement readiness', (s) => (s.placementReadiness != null ? `${num(s.placementReadiness, 0)}%` : '—')],
                        ['Verified skill gap', (s) => (s.verifiedSkillGapPct != null ? `${num(s.verifiedSkillGapPct, 0)}%` : '—')]].map(([label, fn]) => (
                        <tr key={label}><th className="px-4 py-2.5 text-xs font-medium text-muted">{label}</th>{d.students.map((s) => <td key={s.id} className="px-4 py-2.5 tabular-nums">{fn(s)}</td>)}</tr>
                      ))}
                      <tr><th className="px-4 py-2.5 text-xs font-medium text-muted">Risk</th>{d.students.map((s) => <td key={s.id} className="px-4 py-2.5"><RiskPill band={s.risk} /></td>)}</tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}</Async>
        )}
      </div>
    </div>
  );
}

export default function Analytics() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'subjects';
  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Analytics" subtitle="Calculated from verified data only." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'subjects', label: 'Subjects & performers' }, { id: 'risk', label: 'At-risk students' }, { id: 'skills', label: 'Skill gap' }, { id: 'compare', label: 'Compare' }]} />
      {tab === 'risk' ? <RiskTab /> : tab === 'skills' ? <SkillTab /> : tab === 'compare' ? <CompareTab /> : <SubjectsTab />}
    </>
  );
}
