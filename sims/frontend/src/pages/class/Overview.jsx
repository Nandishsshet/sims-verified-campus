import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, Stat, num, useLoad, useToast } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { RiskPill, TYPE_LABEL, pctTone } from './shared';

/** Axis + tooltip props shared by the two distribution charts. */
const Distribution = ({ data, color, label }) => (
  <div className="h-52" role="img" aria-label={label}>
    <ResponsiveContainer>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
        <Tooltip formatter={(v) => [v, 'Students']} cursor={{ fill: 'var(--surface-2)' }} />
        <Bar dataKey="count" fill={color} radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  </div>
);

export default function Overview() {
  const { url, current } = useClass();
  const toast = useToast();
  const s = useLoad(() => api.get(url('/analytics/overview')), [current.id]);
  const key = useLoad(() => api.get(url()), [current.id]);

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Class Key copied'); } catch { toast('Copy failed — select the key and copy it manually', 'error'); } };

  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Class dashboard" subtitle="Everything here is calculated from verified data only." />
      <Async state={s}>{(d) => (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Students" value={d.students} hint={d.pendingJoinRequests ? `${d.pendingJoinRequests} waiting to join` : 'All requests handled'} />
            <Stat label="To verify" value={d.pendingVerifications.total} tone={d.pendingVerifications.total ? 'warn' : 'good'} hint={d.pendingVerifications.total ? 'Open the verification center' : 'Queue is clear'} />
            <Stat label="Average CGPA" value={num(d.averages.cgpa, 2)} tone="brand" hint={d.passPct != null ? `${num(d.passPct, 0)}% have no backlog` : 'No verified marks yet'} />
            <Stat label="Average attendance" value={d.averages.attendancePct != null ? `${num(d.averages.attendancePct)}%` : '—'} tone={d.averages.attendancePct == null ? 'default' : d.averages.attendancePct >= 75 ? 'good' : 'bad'} hint={d.belowAttendance ? `${d.belowAttendance} below 75%` : 'Nobody below 75%'} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title="Needs your attention" className="lg:col-span-2" action={<Link to="/class/verification" className="text-xs font-medium text-brand hover:underline">Verification center</Link>}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Link to="/class/verification" className="rounded-xl border border-line p-4 hover:bg-surface-2">
                  <div className="text-sm font-medium">Items awaiting verification</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.keys(d.pendingVerifications.byType).length === 0 ? <span className="text-sm text-muted">Nothing pending 🎉</span>
                      : Object.entries(d.pendingVerifications.byType).map(([t, n]) => <Pill key={t} tone="warn">{n} {TYPE_LABEL[t] || t}</Pill>)}
                  </div>
                </Link>
                <Link to="/class/requests" className="rounded-xl border border-line p-4 hover:bg-surface-2">
                  <div className="text-sm font-medium">Join requests</div>
                  <div className="mt-2 text-sm text-muted">{d.pendingJoinRequests ? <Pill tone="warn">{d.pendingJoinRequests} pending</Pill> : 'No pending requests'}</div>
                </Link>
                <Link to="/class/analytics?tab=risk" className="rounded-xl border border-line p-4 hover:bg-surface-2 sm:col-span-2">
                  <div className="text-sm font-medium">Dropout risk</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="flex items-center gap-1.5 text-sm"><RiskPill band="high" /> <b>{d.risk.high}</b></span>
                    <span className="flex items-center gap-1.5 text-sm"><RiskPill band="medium" /> <b>{d.risk.medium}</b></span>
                    <span className="flex items-center gap-1.5 text-sm"><RiskPill band="low" /> <b>{d.risk.low}</b></span>
                    {d.risk.unknown > 0 && <span className="flex items-center gap-1.5 text-sm"><RiskPill band="unknown" /> <b>{d.risk.unknown}</b></span>}
                  </div>
                </Link>
              </div>
            </Card>

            <Card title="Class Key" action={<Link to="/class/requests" className="text-xs font-medium text-brand hover:underline">Manage</Link>}>
              {key.data?.key ? (
                <>
                  <button onClick={() => copy(key.data.key.keyValue)} title="Copy" className="w-full rounded-2xl border border-line bg-surface-2 p-4 text-center font-mono text-xl font-semibold tracking-widest hover:border-brand">{key.data.key.keyValue}</button>
                  <p className="mt-3 text-xs text-muted">{key.data.key.useCount ?? 0} student{key.data.key.useCount === 1 ? '' : 's'} joined with this key.</p>
                </>
              ) : <p className="text-sm text-muted">No active key. Generate one under Join requests.</p>}
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title="Attendance distribution">
              {d.averages.attendancePct == null ? <Empty title="No verified attendance yet">Record attendance under Data entry.</Empty> : <Distribution data={d.attendanceDistribution} color="var(--brand)" label="Number of students per attendance band" />}
            </Card>
            <Card title="CGPA distribution">
              {d.averages.cgpa == null ? <Empty title="No verified marks yet">Enter or import marks to see this.</Empty> : <Distribution data={d.cgpaDistribution} color="var(--good)" label="Number of students per CGPA band" />}
            </Card>
            <Card title="Class average SGPA">
              {d.sgpaTrend.length === 0 ? <Empty title="No semester results yet" /> : (
                <div className="h-52" role="img" aria-label="Class average SGPA by semester">
                  <ResponsiveContainer>
                    <LineChart data={d.sgpaTrend} margin={{ top: 8, right: 12, left: -22, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="semester" tickFormatter={(v) => `Sem ${v}`} tickLine={false} axisLine={false} />
                      <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tickLine={false} axisLine={false} />
                      <Tooltip formatter={(v) => [num(v, 2), 'Average SGPA']} labelFormatter={(v) => `Semester ${v}`} />
                      <Line type="monotone" dataKey="avgSgpa" stroke="var(--brand)" strokeWidth={2.5} dot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title="Class snapshot" className="lg:col-span-2">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                {[['Verified certificates', d.certificates.verified], ['Per student', num(d.certificates.perStudent, 1)], ['Verified projects', d.projects],
                  ['Students with backlogs', d.withBacklogs], ['Placement readiness', d.averages.placementReadiness != null ? `${num(d.averages.placementReadiness, 0)}%` : '—'],
                  ['Verified skill gap', d.averages.verifiedSkillGapPct != null ? `${num(d.averages.verifiedSkillGapPct, 0)}%` : '—']].map(([k, v]) => (
                  <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{v}</dd></div>
                ))}
              </dl>
            </Card>
            <Card title="Leaderboard top 3" action={<Link to="/class/leaderboard" className="text-xs font-medium text-brand hover:underline">Full board</Link>}>
              {d.leaderboardTop.length === 0 ? <p className="text-sm text-muted">No students yet.</p> : (
                <ol className="space-y-2.5">{d.leaderboardTop.map((t) => (
                  <li key={t.rank + t.name} className="flex items-center justify-between text-sm"><span className="flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">{t.rank}</span>{t.name}</span><span className={`tabular-nums font-medium ${pctTone(t.score, 60, 40)}`}>{num(t.score)}</span></li>
                ))}</ol>
              )}
            </Card>
          </div>
        </>
      )}</Async>
    </>
  );
}
