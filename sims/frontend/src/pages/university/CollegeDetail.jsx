import { Link, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, Stat, fmtDate, num, useLoad } from '../../ui';
import { METRICS, RAW, ComponentBars, RankBadge, RiskBar, ScoreText } from '../college/shared';
import { StatusPill } from './shared';

/** One college seen from the university: its score against the university average, departments, cohorts and flags. */
export default function CollegeDetail() {
  const { id } = useParams();
  const q = useLoad(() => api.get(`/university/colleges/${id}`), [id]);
  return (
    <Async state={q}>{(d) => {
      const c = d.college; const s = d.summary;
      return (
        <>
          <PageHeader title={c.name} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusPill status={c.status} />{c.principalName ? `Principal ${c.principalName} · ` : ''}Admin {c.admin.name} ({c.admin.email})</span>}
            action={<Link to="/university/colleges" className="text-sm font-medium text-brand hover:underline">← All colleges</Link>} />
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="University rank" value={d.rank ? `${d.rank} of ${d.of}` : '—'} hint={d.rank ? null : 'not ranked yet'} />
              <Stat label="Students" value={s.students} />
              <Stat label="Instructors" value={c.instructors} hint={c.pendingInstructors ? `${c.pendingInstructors} pending` : null} />
              <Stat label="Awaiting review" value={d.pending.total} tone={d.pending.stale ? 'bad' : 'default'} hint={d.pending.stale ? `${d.pending.stale} older than 7 days` : null} />
            </div>

            {d.alerts && (
              <Card title="Why this college is flagged" action={<Pill tone={d.alerts.severity === 'critical' ? 'bad' : 'warn'}>{d.alerts.severity}</Pill>}>
                <ul className="space-y-1.5 text-sm">{d.alerts.reasons.map((r) => <li key={r} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-warn" />{r}</li>)}</ul>
              </Card>
            )}

            {s.students === 0 ? <Empty title={c.status === 'active' ? 'No students yet' : `This college is ${c.status}`}>{c.status === 'active' ? 'Scores appear once instructors create classes and verify attendance or marks.' : 'It has no data in the university figures until it is approved and active.'}</Empty> : (
              <>
                <div className="grid gap-6 lg:grid-cols-3">
                  <Card title="College score vs the university" className="lg:col-span-2">
                    <div className="grid gap-6 md:grid-cols-[10rem_1fr]">
                      <div className="text-center md:text-left">
                        <div className="text-5xl font-semibold tabular-nums tracking-tight text-brand">{s.score == null ? '—' : num(s.score)}</div>
                        <div className="mt-1 text-xs text-muted">out of 100{d.university.score != null && <> · university {num(d.university.score)}</>}</div>
                        {s.behind.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{s.behind.map((k) => <Pill key={k} tone="warn">Behind: {METRICS[k]}</Pill>)}</div>}
                      </div>
                      <ComponentBars components={s.components} weak={s.weak} college={d.university.components} parentLabel="university" />
                    </div>
                  </Card>
                  <Card title="Dropout risk"><RiskBar risk={s.risk} /></Card>
                </div>

                <div className="grid gap-6 lg:grid-cols-3">
                  <Card title="Departments" pad={false} className="lg:col-span-2">
                    {d.departments.length === 0 ? <p className="p-5 text-sm text-muted">No departments yet.</p> : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[620px] text-left text-sm">
                          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Department</th><th className="px-3 py-3 text-right">Students</th>{['attendancePct', 'avgSgpa', 'passPct'].map((k) => <th key={k} className="px-3 py-3 text-right">{RAW[k][0]}</th>)}<th className="px-4 py-3 text-right">Score</th></tr></thead>
                          <tbody className="divide-y divide-line">{d.departments.map((x) => (
                            <tr key={x.id}><td className="px-4 py-3"><RankBadge rank={x.rank} /></td><td className="px-4 py-3"><span className="font-medium">{x.name}</span> <span className="text-xs text-muted">{x.code}</span>{x.weak.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{x.weak.map((k) => <Pill key={k} tone="bad">Weak: {METRICS[k]}</Pill>)}</div>}</td>
                              <td className="px-3 py-3 text-right tabular-nums">{x.students}</td>{['attendancePct', 'avgSgpa', 'passPct'].map((k) => <td key={k} className="px-3 py-3 text-right tabular-nums">{x.metrics ? RAW[k][1](x.metrics[k]) : '—'}</td>)}
                              <td className="px-4 py-3 text-right"><ScoreText score={x.score} className="text-base" /></td></tr>
                          ))}</tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                  <Card title="Admission cohorts" pad={false}>
                    <ul className="divide-y divide-line">{d.cohorts.map((y) => <li key={y.year} className="flex items-center justify-between px-5 py-3 text-sm"><span><b>{y.year}</b> <span className="text-muted">· {y.students} student{y.students === 1 ? '' : 's'}</span></span><ScoreText score={y.score} /></li>)}</ul>
                  </Card>
                </div>

                {d.sgpaTrend.length > 0 && (
                  <Card title="Average SGPA by semester">
                    <div className="h-64" role="img" aria-label="Line chart of average SGPA per semester">
                      <ResponsiveContainer>
                        <LineChart data={d.sgpaTrend} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" /><XAxis dataKey="semester" tickFormatter={(v) => `Sem ${v}`} tick={{ fontSize: 11 }} /><YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
                          <Tooltip formatter={(v) => num(v, 2)} labelFormatter={(v) => `Semester ${v}`} />
                          <Line type="monotone" dataKey="avgSgpa" name="Average SGPA" stroke="var(--brand)" strokeWidth={2} dot />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </Card>
                )}
              </>
            )}

            <Card title="Profile">
              <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                {[['Affiliation', c.affiliation], ['Address', c.address], ['Contact e-mail', c.contactEmail], ['Contact phone', c.contactPhone], ['Registered', fmtDate(c.createdAt)], ['Approved', c.approvedAt ? fmtDate(c.approvedAt) : '—'], ['College Key', d.key?.keyValue]].map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className={k === 'College Key' ? 'font-mono' : ''}>{v || '—'}</dd></div>)}
              </dl>
            </Card>
          </div>
        </>
      );
    }}</Async>
  );
}
