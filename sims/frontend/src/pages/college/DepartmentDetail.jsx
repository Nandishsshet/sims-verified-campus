import { Link, useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, Stat, num, useLoad } from '../../ui';
import { pctTone } from '../class/shared';
import { ComponentBars, METRICS, METRIC_KEYS, RankBadge, RiskBar, ScoreText } from './shared';

export default function DepartmentDetail() {
  const { id } = useParams();
  const q = useLoad(() => api.get(`/college/analytics/departments/${id}`), [id]);
  return (
    <Async state={q}>{(d) => {
      const s = d.summary;
      const versus = METRIC_KEYS.map((k) => ({ metric: METRICS[k].replace(' readiness', '').replace('Event participation', 'Events'), department: s.components ? Math.round(s.components[k]) : null, college: d.college.components ? Math.round(d.college.components[k]) : null }));
      return (
        <>
          <Link to="/college/departments" className="mb-3 inline-block text-xs font-medium text-brand hover:underline">← Departments</Link>
          <PageHeader title={`${d.department.name}`} subtitle={`${d.department.code}${d.department.hodName ? ` · HOD ${d.department.hodName}` : ''} · ${s.students} student${s.students === 1 ? '' : 's'}`}
            action={<div className="flex items-center gap-3"><RankBadge rank={d.rank} /><div className="text-sm"><div className="text-xs text-muted">{d.rank ? `Rank ${d.rank} of ${d.of}` : 'Not ranked'}</div><ScoreText score={s.score} className="text-lg" /></div></div>} />

          {s.behind.length > 0 && (
            <div className="mb-6 rounded-2xl border border-warn/40 bg-warn-soft px-5 py-3.5 text-sm text-warn" role="status">
              <b>Behind the college average</b> by more than 10 points on: {s.behind.map((k) => METRICS[k]).join(', ')}.
            </div>
          )}

          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Average SGPA" value={s.metrics ? num(s.metrics.avgSgpa, 2) : null} />
            <Stat label="Attendance" value={s.metrics ? `${num(s.metrics.attendancePct)}%` : null} tone={s.metrics && s.metrics.attendancePct < 75 ? 'bad' : 'default'} />
            <Stat label="No backlog" value={s.metrics ? `${num(s.metrics.passPct)}%` : null} />
            <Stat label="Events attended" value={s.metrics ? `${num(s.metrics.eventParticipationPct, 0)}%` : null} hint="of students" />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Score components">
              <ComponentBars components={s.components} weak={s.weak} college={d.college.components} />
            </Card>
            <Card title="Department vs college average">
              {!s.components ? <p className="text-sm text-muted">No verified data yet.</p> : (
                <div className="h-72" role="img" aria-label="Department score components against the college average">
                  <ResponsiveContainer>
                    {/* horizontal bars: the metric names are too long to sit under vertical ones */}
                    <BarChart data={versus} layout="vertical" margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="metric" width={96} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
                      <Tooltip /><Legend />
                      <Bar dataKey="department" name="This department" fill="var(--brand)" radius={[0, 6, 6, 0]} />
                      <Bar dataKey="college" name="College" fill="var(--muted)" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
            <Card title="Average SGPA by semester">
              {d.sgpaTrend.length === 0 ? <p className="text-sm text-muted">No verified marks yet.</p> : (
                <div className="h-60" role="img" aria-label="Average SGPA per semester">
                  <ResponsiveContainer>
                    <LineChart data={d.sgpaTrend} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="semester" tickLine={false} axisLine={false} tickFormatter={(v) => `Sem ${v}`} />
                      <YAxis domain={[0, 10]} tickLine={false} axisLine={false} />
                      <Tooltip formatter={(v, n, p) => [`${num(v, 2)} (${p.payload.students} students)`, 'Average SGPA']} labelFormatter={(v) => `Semester ${v}`} />
                      <Line type="monotone" dataKey="avgSgpa" stroke="var(--brand)" strokeWidth={2.5} dot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
            <Card title="Events by month">
              {d.eventTimeline.length === 0 ? <p className="text-sm text-muted">No published events yet. Add one from Events &amp; announcements.</p> : (
                <div className="h-60" role="img" aria-label="Events held and students who attended, per month">
                  <ResponsiveContainer>
                    <BarChart data={d.eventTimeline} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="month" tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                      <Tooltip /><Legend />
                      <Bar dataKey="events" name="Events held" fill="var(--brand)" radius={[6, 6, 0, 0]} />
                      <Bar dataKey="attended" name="Students attended" fill="var(--good)" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>

          <Card title="Classes" className="mt-6" pad={false}>
            {d.classes.length === 0 ? <div className="p-5"><Empty title="No classes yet">An instructor creates a class under this department.</Empty></div> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-3">Rank</th><th className="px-3 py-3">Class</th><th className="px-3 py-3">Instructor</th><th className="px-3 py-3 text-right">Students</th><th className="px-3 py-3 text-right">Attendance</th><th className="px-3 py-3 text-right">Queue</th><th className="px-5 py-3 text-right">Score</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {d.classes.map((c) => (
                      <tr key={c.id}>
                        <td className="px-5 py-3"><RankBadge rank={c.rank} /></td>
                        <td className="px-3 py-3"><span className="font-medium">{c.name}</span> <span className="text-xs text-muted">sem {c.semester}</span>{c.status !== 'active' && <> <Pill tone="muted">{c.status}</Pill></>}{c.weak.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{c.weak.map((k) => <Pill key={k} tone="bad">{METRICS[k]}</Pill>)}</div>}</td>
                        <td className="px-3 py-3 text-muted">{c.instructor || '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{c.students}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${pctTone(c.metrics?.attendancePct)}`}>{c.metrics ? `${num(c.metrics.attendancePct)}%` : '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{c.pending.total ? <span className={c.pending.stale ? 'font-medium text-bad' : ''}>{c.pending.total}{c.pending.stale ? ` (${c.pending.stale} stale)` : ''}</span> : '—'}</td>
                        <td className="px-5 py-3 text-right"><ScoreText score={c.score} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card title="Dropout risk"><RiskBar risk={s.risk} /></Card>
            <Card title="Top students" pad={false}>
              {d.topStudents.length === 0 ? <p className="p-5 text-sm text-muted">No ranked students yet.</p> : (
                <ul className="divide-y divide-line">{d.topStudents.map((t) => <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm"><RankBadge rank={t.rank} /><span className="flex-1 font-medium">{t.name}</span><b className="tabular-nums">{num(t.score)}</b></li>)}</ul>
              )}
            </Card>
          </div>
        </>
      );
    }}</Async>
  );
}
