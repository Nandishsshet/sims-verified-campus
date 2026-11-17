import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, Select, Stat, num, useLoad } from '../../ui';
import { Tabs, pctTone } from '../class/shared';
import { ComponentBars, METRICS, RAW, RiskBar, ScoreText } from '../college/shared';
import { heatStyle } from './shared';

const COLORS = ['var(--brand)', 'var(--good)', 'var(--warn)', 'var(--info)', 'var(--bad)'];
const short = (k) => METRICS[k].replace(' readiness', '').replace('Event participation', 'Events').replace('Verified skills', 'Skills');
const th = 'px-3 py-3 text-right';

/** A ranked group table (colleges or department codes) with the headline raw metrics. */
function GroupTable({ title, rows, nameCell }) {
  return (
    <Card pad={false} title={title}>
      {rows.length === 0 ? <p className="p-5 text-sm text-muted">Nothing matches the filters.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-3">Name</th><th className={th}>Score</th><th className={th}>Students</th>{Object.values(RAW).map(([label]) => <th key={label} className={th}>{label}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-5 py-3">{nameCell(r)}{r.weak.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{r.weak.map((k) => <Pill key={k} tone="bad">Weak: {short(k)}</Pill>)}</div>}</td>
                  <td className={th}><ScoreText score={r.score} /></td><td className={`${th} tabular-nums`}>{r.students}</td>
                  {Object.entries(RAW).map(([k, [, fmt]]) => <td key={k} className={`${th} tabular-nums ${k === 'attendancePct' ? pctTone(r.metrics?.[k]) : ''}`}>{r.metrics ? fmt(r.metrics[k]) : '—'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Filterable breakdown: by college, by department code (grouped across colleges) and by admission year. */
function BreakdownTab() {
  const [f, setF] = useState({ collegeId: '', departmentCode: '', admissionYear: '', semester: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const q = useLoad(() => api.get(`/university/analytics${qs ? `?${qs}` : ''}`), [qs]);
  const opts = useLoad(() => api.get('/university/analytics'));          // unfiltered, so the drop-downs never shrink while a filter is applied
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const o = opts.data?.filters.options;
  const active = Object.values(f).some(Boolean);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="College" className="!w-auto" value={f.collegeId} onChange={set('collegeId')}><option value="">All colleges</option>{o?.colleges.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Department" className="!w-auto" value={f.departmentCode} onChange={set('departmentCode')}><option value="">All departments</option>{o?.departmentCodes.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        <Select aria-label="Admission year" className="!w-auto" value={f.admissionYear} onChange={set('admissionYear')}><option value="">All batches</option>{o?.admissionYears.map((y) => <option key={y} value={y}>Batch of {y}</option>)}</Select>
        <Select aria-label="Semester" className="!w-auto" value={f.semester} onChange={set('semester')}><option value="">All semesters</option>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1} only</option>)}</Select>
        {active && <button onClick={() => setF({ collegeId: '', departmentCode: '', admissionYear: '', semester: '' })} className="text-xs font-medium text-brand hover:underline">Clear filters</button>}
      </div>
      <Async state={q}>{(a) => a.summary.students === 0 ? <Empty title="No students match these filters">Try removing a filter. Only verified data of active colleges is counted.</Empty> : (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Selected students" className="lg:col-span-2">
              <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3"><Stat label="Students" value={a.summary.students} /><Stat label="Score" value={a.summary.score == null ? '—' : num(a.summary.score)} /><Stat label="Weak areas" value={a.summary.weak.length} tone={a.summary.weak.length ? 'warn' : 'good'} /></div>
              <ComponentBars components={a.summary.components} weak={a.summary.weak} />
            </Card>
            <Card title="Dropout risk"><RiskBar risk={a.summary.risk} /></Card>
          </div>
          <GroupTable title="By college" rows={a.byCollege} nameCell={(r) => <Link to={`/university/colleges/${r.id}`} className="font-medium hover:text-brand">{r.name}</Link>} />
          <GroupTable title="By department (same code across colleges is one row)" rows={a.byDepartment} nameCell={(r) => <><span className="font-medium">{r.code}</span> <span className="text-xs text-muted">in {r.colleges} college{r.colleges === 1 ? '' : 's'}</span></>} />
          <Card title="By admission year" pad={false}>
            <ul className="divide-y divide-line">{a.byYear.map((y) => <li key={y.year} className="flex items-center justify-between px-5 py-3 text-sm"><span><b>Batch of {y.year}</b> <span className="text-muted">· {y.students} student{y.students === 1 ? '' : 's'} in {y.colleges} college{y.colleges === 1 ? '' : 's'}</span></span><ScoreText score={y.score} /></li>)}</ul>
          </Card>
          {a.sgpaTrend.length > 0 && (
            <Card title="Average SGPA by semester">
              <div className="h-64" role="img" aria-label="Line chart of average SGPA per semester">
                <ResponsiveContainer>
                  <LineChart data={a.sgpaTrend} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                    <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" /><XAxis dataKey="semester" tickFormatter={(v) => `Sem ${v}`} tick={{ fontSize: 11 }} /><YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => num(v, 2)} labelFormatter={(v) => `Semester ${v}`} />
                    <Line type="monotone" dataKey="avgSgpa" name="Average SGPA" stroke="var(--brand)" strokeWidth={2} dot />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}
          <p className="text-xs text-muted">“Weak” means a component below 60 of 100. Missing data counts as 0, so a group that has not entered attendance gets no credit for it. See docs/SCORING.md.</p>
        </>
      )}</Async>
    </div>
  );
}

/** College × component matrix. Cells are tinted by value, and the number is always shown. */
function HeatmapTab() {
  const q = useLoad(() => api.get('/university/analytics/heatmap'));
  return (
    <Async state={q}>{({ metrics, rows, university }) => rows.length === 0 ? <Empty title="No active college yet" /> : (
      <Card pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-3">College</th><th className={th}>Score</th>{metrics.map((k) => <th key={k} className={th}>{short(k)}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-3"><Link to={`/university/colleges/${r.id}`} className="font-medium hover:text-brand">{r.name}</Link><div className="text-xs text-muted">{r.students} student{r.students === 1 ? '' : 's'}</div></td>
                  <td className={th}><ScoreText score={r.score} /></td>
                  {metrics.map((k) => <td key={k} className={`${th} tabular-nums`} style={r.students ? heatStyle(r.values[k]) : undefined}>{r.students ? num(r.values[k], 0) : '—'}</td>)}
                </tr>
              ))}
              <tr className="bg-surface-2/60 font-medium"><td className="px-5 py-3">University</td><td className={th}><ScoreText score={university.score} /></td>{metrics.map((k) => <td key={k} className={`${th} tabular-nums`}>{university.values?.[k] == null ? '—' : num(university.values[k], 0)}</td>)}</tr>
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-muted">Each cell is a 0–100 component of the score. Red cells are weak (below 60); green cells are healthy. Colleges without verified data show a dash.</p>
      </Card>
    )}</Async>
  );
}

/** Score by admission year, one line per college plus the university's own figure. */
function TrendsTab() {
  const q = useLoad(() => api.get('/university/analytics/yoy'));
  return (
    <Async state={q}>{({ years, series }) => years.length === 0 ? <Empty title="No cohort data yet">Batches appear once students with verified data are admitted.</Empty> : (
      <div className="space-y-6">
        <Card title="Score by admission year">
          <div className="h-72" role="img" aria-label="Line chart of score by admission year, one line per college">
            <ResponsiveContainer>
              <LineChart data={years.map((y) => ({ year: y.year, University: y.score, ...Object.fromEntries(series.map((s) => [s.name, s.points.find((p) => p.year === y.year)?.score ?? null])) }))} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" /><XAxis dataKey="year" tick={{ fontSize: 11 }} /><YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => (v == null ? '—' : num(v))} /><Legend />
                <Line type="monotone" dataKey="University" stroke="var(--ink)" strokeWidth={2.5} dot />
                {series.map((s, i) => <Line key={s.collegeId} type="monotone" dataKey={s.name} stroke={COLORS[i % COLORS.length]} strokeWidth={1.75} strokeDasharray="5 3" connectNulls dot />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Batches" pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-3">Batch</th><th className={th}>Students</th><th className={th}>Colleges</th><th className={th}>Attendance</th><th className={th}>SGPA</th><th className={th}>Score</th><th className="px-5 py-3 text-right">vs previous</th></tr></thead>
              <tbody className="divide-y divide-line">{years.map((y) => (
                <tr key={y.year}><td className="px-5 py-3 font-medium">{y.year}</td><td className={`${th} tabular-nums`}>{y.students}</td><td className={`${th} tabular-nums`}>{y.colleges}</td>
                  <td className={`${th} tabular-nums`}>{y.metrics ? `${num(y.metrics.attendancePct)}%` : '—'}</td><td className={`${th} tabular-nums`}>{y.metrics ? num(y.metrics.avgSgpa, 2) : '—'}</td><td className={th}><ScoreText score={y.score} /></td>
                  <td className={`px-5 py-3 text-right tabular-nums ${y.delta == null ? 'text-muted' : y.delta >= 0 ? 'text-good' : 'text-bad'}`}>{y.delta == null ? '—' : `${y.delta > 0 ? '+' : ''}${num(y.delta)}`}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
        <p className="text-xs text-muted">A batch is the year students were admitted. Scores use the same formula as everywhere else, so batches are comparable even though older batches have more semesters of data.</p>
      </div>
    )}</Async>
  );
}

export default function Analytics() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'breakdown';
  return (
    <>
      <PageHeader title="University analytics" subtitle="Compare colleges, departments and batches from verified data — the same formula at every level." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'breakdown', label: 'Breakdown' }, { id: 'heatmap', label: 'College heat-map' }, { id: 'trends', label: 'Year over year' }]} />
      {tab === 'heatmap' ? <HeatmapTab /> : tab === 'trends' ? <TrendsTab /> : <BreakdownTab />}
    </>
  );
}
