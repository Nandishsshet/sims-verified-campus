import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from 'recharts';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, num, useLoad } from '../../ui';
import { Tabs, pctTone } from '../class/shared';
import { METRICS, METRIC_KEYS, RAW, RiskBar, ScoreText } from './shared';

const COLORS = ['var(--brand)', 'var(--good)', 'var(--warn)', 'var(--info)'];
const short = (k) => METRICS[k].replace(' readiness', '').replace('Event participation', 'Events');

/** Raw metrics of every department next to the college average, with the weak components flagged. */
function MetricsTab() {
  const q = useLoad(() => api.get('/college/analytics/departments'));
  return (
    <Async state={q}>{({ departments, college }) => departments.length === 0 ? <Empty title="No departments yet" /> : (
      <div className="space-y-6">
        <Card pad={false} title="Metrics by department">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-5 py-3">Department</th><th className="px-3 py-3 text-right">Score</th>{Object.values(RAW).map(([label]) => <th key={label} className="px-3 py-3 text-right">{label}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {departments.map((d) => (
                  <tr key={d.id} className="align-top">
                    <td className="px-5 py-3"><Link to={`/college/departments/${d.id}`} className="font-medium hover:text-brand">{d.name}</Link> <span className="text-xs text-muted">{d.code}</span>
                      <div className="text-xs text-muted">{d.students} student{d.students === 1 ? '' : 's'}{!d.hasData && ' · no verified data yet'}</div>
                      {d.weak.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{d.weak.map((k) => <Pill key={k} tone="bad">Weak: {short(k)}</Pill>)}</div>}
                      {d.behind.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{d.behind.map((k) => <Pill key={k} tone="warn">Behind college: {short(k)}</Pill>)}</div>}</td>
                    <td className="px-3 py-3 text-right"><ScoreText score={d.score} /></td>
                    {Object.entries(RAW).map(([k, [, fmt]]) => <td key={k} className={`px-3 py-3 text-right tabular-nums ${k === 'attendancePct' ? pctTone(d.metrics?.[k]) : ''}`}>{d.metrics ? fmt(d.metrics[k]) : '—'}</td>)}
                  </tr>
                ))}
                <tr className="bg-surface-2/60 font-medium">
                  <td className="px-5 py-3">College</td><td className="px-3 py-3 text-right"><ScoreText score={college.score} /></td>
                  {Object.entries(RAW).map(([k, [, fmt]]) => <td key={k} className="px-3 py-3 text-right tabular-nums">{college.metrics ? fmt(college.metrics[k]) : '—'}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Dropout risk by department">
          <ul className="space-y-5">{departments.map((d) => <li key={d.id}><div className="mb-1.5 text-sm font-medium">{d.name}</div><RiskBar risk={d.risk} /></li>)}</ul>
        </Card>
        <p className="text-xs text-muted">“Weak” means a component below 60 of 100. “Behind college” means more than 10 points under the college average. Missing data counts as 0, so a department that has not entered attendance gets no credit for it. See docs/SCORING.md.</p>
      </div>
    )}</Async>
  );
}

/** Pick 2–4 departments and overlay their components on a radar chart. */
function CompareTab() {
  const list = useLoad(() => api.get('/college/departments'));
  const [ids, setIds] = useState([]);
  const cmp = useLoad(() => (ids.length >= 2 ? api.get(`/college/analytics/compare?departmentIds=${ids.join(',')}`) : Promise.resolve(null)), [ids.join(',')]);
  const toggle = (id) => setIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : l.length >= 4 ? l : [...l, id]));

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title={`Pick 2–4 departments (${ids.length})`} pad={false}>
        <Async state={list}>{({ departments }) => departments.length < 2 ? <p className="p-5 text-sm text-muted">You need at least two departments to compare.</p> : (
          <ul className="divide-y divide-line">{departments.map((d) => (
            <li key={d.id}><label className="flex cursor-pointer items-center gap-3 px-5 py-3 text-sm hover:bg-surface-2"><input type="checkbox" checked={ids.includes(d.id)} disabled={!ids.includes(d.id) && ids.length >= 4} onChange={() => toggle(d.id)} /><span className="min-w-0 flex-1 truncate">{d.name}</span><span className="text-xs text-muted">{d.code}</span></label></li>
          ))}</ul>
        )}</Async>
      </Card>
      <div className="space-y-6 lg:col-span-2">
        {ids.length < 2 ? <Empty title="Choose at least two departments" /> : (
          <Async state={cmp}>{(d) => d && (
            <>
              <Card title="Score components">
                <div className="h-80" role="img" aria-label="Radar chart comparing department score components">
                  <ResponsiveContainer>
                    <RadarChart data={METRIC_KEYS.map((k) => ({ axis: short(k), ...Object.fromEntries(d.departments.map((x) => [x.id, Math.round(x.components?.[k] ?? 0)])) }))}>
                      <PolarGrid /><PolarAngleAxis dataKey="axis" tick={{ fontSize: 11 }} /><PolarRadiusAxis angle={60} domain={[0, 100]} tick={{ fontSize: 10 }} />
                      {d.departments.map((x, i) => <Radar key={x.id} name={x.name} dataKey={x.id} stroke={COLORS[i]} fill={COLORS[i]} fillOpacity={0.15} />)}
                      <Legend /><Tooltip />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card pad={false}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-left text-sm">
                    <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3" />{d.departments.map((x) => <th key={x.id} className="px-4 py-3 normal-case text-ink">{x.name}</th>)}</tr></thead>
                    <tbody className="divide-y divide-line">
                      <tr><th className="px-4 py-2.5 text-xs font-medium text-muted">Score</th>{d.departments.map((x) => <td key={x.id} className="px-4 py-2.5"><ScoreText score={x.score} /></td>)}</tr>
                      <tr><th className="px-4 py-2.5 text-xs font-medium text-muted">Students</th>{d.departments.map((x) => <td key={x.id} className="px-4 py-2.5 tabular-nums">{x.students}</td>)}</tr>
                      {Object.entries(RAW).map(([k, [label, fmt]]) => <tr key={k}><th className="px-4 py-2.5 text-xs font-medium text-muted">{label}</th>{d.departments.map((x) => <td key={x.id} className="px-4 py-2.5 tabular-nums">{x.metrics ? fmt(x.metrics[k]) : '—'}</td>)}</tr>)}
                      <tr><th className="px-4 py-2.5 text-xs font-medium text-muted">Weak areas</th>{d.departments.map((x) => <td key={x.id} className="px-4 py-2.5 text-xs">{x.weak.length ? x.weak.map(short).join(', ') : '—'}</td>)}</tr>
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
  const tab = sp.get('tab') || 'metrics';
  return (
    <>
      <PageHeader title="College analytics" subtitle="Department performance from verified data — the same formula at every level." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'metrics', label: 'Metrics & risk' }, { id: 'compare', label: 'Compare departments' }]} />
      {tab === 'compare' ? <CompareTab /> : <MetricsTab />}
    </>
  );
}
