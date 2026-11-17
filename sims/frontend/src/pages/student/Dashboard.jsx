import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Async, Card, Empty, PageHeader, Pill, Progress, Stat, fmtDate, num, useLoad } from '../../ui';

const SEV = {
  critical: ['bad', 'Action needed'], warning: ['warn', 'Heads up'], info: ['info', 'Tip'], positive: ['good', 'Nice'],
};
const toneFor = (v, good = 75, ok = 50) => (v >= good ? 'good' : v >= ok ? 'warn' : 'bad');

export default function Dashboard() {
  const { user } = useAuth();
  const s = useLoad(() => api.get('/student/dashboard'));

  return (
    <Async state={s}>{(d) => (
      <>
        <PageHeader title={`Hi, ${user.fullName.split(' ')[0]}`} subtitle={`${d.class.name} · Semester ${d.class.currentSemester}`}
          action={d.verification.pending > 0 && <Link to="/student/verification"><Pill tone="warn">{d.verification.pending} item{d.verification.pending > 1 ? 's' : ''} awaiting verification</Pill></Link>} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="CGPA" value={num(d.academics.cgpa, 2)} hint={d.academics.latestSgpa != null ? `Latest SGPA ${num(d.academics.latestSgpa, 2)}` : 'No verified results yet'} tone="brand" />
          <Stat label="Attendance" value={d.attendance.held ? `${num(d.attendance.percentage)}%` : '—'} tone={d.attendance.held ? toneFor(d.attendance.percentage) : 'default'}
            hint={d.attendance.held ? (d.attendance.toRecover > 0 ? `Attend next ${d.attendance.toRecover} to reach 75%` : `Can miss ${d.attendance.canMiss} more`) : 'Nothing verified yet'} />
          <Stat label="Placement readiness" value={`${num(d.placementReadiness, 0)}%`} tone={toneFor(d.placementReadiness, 70, 45)} hint="Verified data only" />
          <Stat label="Class rank" value={d.rank ? `#${d.rank.rank}` : '—'} hint={d.rank ? `of ${d.rank.of} · score ${num(d.rank.score)}` : 'Unranked'} />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card title="Academic trend" className="lg:col-span-2" action={<Link to="/student/academics" className="text-xs font-medium text-brand hover:underline">Details</Link>}>
            {d.academics.trend.length === 0 ? <Empty title="No verified semester results yet">Results appear once your instructor verifies your marks.</Empty> : (
              <div className="h-60">
                <ResponsiveContainer>
                  <LineChart data={d.academics.trend} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="semester" tickFormatter={(v) => `Sem ${v}`} tickLine={false} axisLine={false} />
                    <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v, n) => [num(v, 2), n === 'sgpa' ? 'SGPA' : 'CGPA']} labelFormatter={(v) => `Semester ${v}`} />
                    <Line type="monotone" dataKey="sgpa" stroke="var(--brand)" strokeWidth={2.5} dot={{ r: 4 }} name="sgpa" />
                    <Line type="monotone" dataKey="cgpa" stroke="var(--muted)" strokeDasharray="5 4" strokeWidth={2} dot={false} name="cgpa" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="mt-3 flex gap-4 text-xs text-muted"><span className="flex items-center gap-1.5"><i className="h-0.5 w-4 bg-brand" />SGPA</span><span className="flex items-center gap-1.5"><i className="h-0.5 w-4 border-t-2 border-dashed border-muted" />CGPA</span>
              {d.academics.backlogs > 0 && <Pill tone="bad">{d.academics.backlogs} active backlog{d.academics.backlogs > 1 ? 's' : ''}</Pill>}</div>
          </Card>

          <Card title="Subjects needing attention" action={<Link to="/student/attendance" className="text-xs font-medium text-brand hover:underline">Attendance</Link>}>
            {d.attendance.lowSubjects.length === 0 ? <p className="text-sm text-muted">{d.attendance.held ? 'Every subject is above 75%. Keep it up!' : 'Attendance appears once your instructor records it.'}</p> : (
              <ul className="space-y-4">{d.attendance.lowSubjects.map((x) => (
                <li key={x.code}><div className="mb-1.5 flex justify-between text-sm"><span className="font-medium">{x.name}</span><span className="tabular-nums text-bad">{num(x.percentage)}%</span></div><Progress value={x.percentage} /></li>
              ))}</ul>
            )}
          </Card>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card title="Suggestions for you" className="lg:col-span-2">
            {d.suggestions.length === 0 ? <p className="text-sm text-muted">Nothing urgent. You're on track.</p> : (
              <ul className="divide-y divide-line">{d.suggestions.map((x) => {
                const [tone, label] = SEV[x.severity] || SEV.info;
                return (
                  <li key={x.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <Pill tone={tone}>{label}</Pill>
                    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{x.title}</p><p className="text-sm text-muted">{x.detail}</p></div>
                    {x.action && <Link to={x.action.to} className="shrink-0 text-xs font-medium text-brand hover:underline">Open</Link>}
                  </li>
                );
              })}</ul>
            )}
          </Card>

          <div className="space-y-6">
            <Card title="Career readiness" action={<Link to="/student/skills" className="text-xs font-medium text-brand hover:underline">Skill gap</Link>}>
              {d.skillGap ? (
                <div className="space-y-3 text-sm">
                  <p className="text-muted">Target: <b className="text-ink">{d.skillGap.role}</b></p>
                  <div><div className="mb-1 flex justify-between"><span>Overall gap</span><b className="tabular-nums">{num(d.skillGap.gapPct)}%</b></div><Progress value={100 - d.skillGap.gapPct} /></div>
                  <div><div className="mb-1 flex justify-between"><span>Verified gap</span><b className="tabular-nums">{num(d.skillGap.verifiedGapPct)}%</b></div><Progress value={100 - d.skillGap.verifiedGapPct} /></div>
                  <p className="text-xs text-muted">Upload certificates / projects to turn declared skills into verified ones.</p>
                </div>
              ) : <p className="text-sm text-muted">Pick a target role to see your skill gap. <Link to="/student/skills" className="font-medium text-brand hover:underline">Choose role</Link></p>}
            </Card>
            <Card title="Resume & achievements">
              <div className="space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-muted">ATS score</span><b>{d.resumeScore != null ? `${d.resumeScore}/100` : <Link to="/student/resume" className="text-brand hover:underline">Create resume</Link>}</b></div>
                <div className="flex justify-between"><span className="text-muted">Verified certificates</span><b>{d.certificates.verified}</b></div>
                <div className="flex justify-between"><span className="text-muted">Verified projects</span><b>{d.portfolio.projects}</b></div>
                <div className="flex justify-between"><span className="text-muted">Badges</span><Link to="/student/achievements" className="font-semibold text-brand hover:underline">{d.badges.earned}/{d.badges.total}</Link></div>
              </div>
            </Card>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title="Assignments due" action={<Link to="/student/planner" className="text-xs font-medium text-brand hover:underline">Planner</Link>}>
            {d.upcoming.assignments.length === 0 ? <p className="text-sm text-muted">No pending assignments.</p> : (
              <ul className="divide-y divide-line">{d.upcoming.assignments.map((a) => <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm first:pt-0 last:pb-0"><span className="font-medium">{a.title}</span><span className="shrink-0 text-xs text-muted">Due {fmtDate(a.due_at, { day: 'numeric', month: 'short' })}</span></li>)}</ul>
            )}
          </Card>
          <Card title="Upcoming activities" action={<Link to="/student/activities" className="text-xs font-medium text-brand hover:underline">All</Link>}>
            {d.upcoming.activities.length === 0 ? <p className="text-sm text-muted">Nothing scheduled.</p> : (
              <ul className="divide-y divide-line">{d.upcoming.activities.map((a) => <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm first:pt-0 last:pb-0"><span><span className="font-medium">{a.title}</span> <Pill tone="brand">{a.type}</Pill></span><span className="shrink-0 text-xs text-muted">{fmtDate(a.starts_at, { day: 'numeric', month: 'short' })}</span></li>)}</ul>
            )}
          </Card>
        </div>
      </>
    )}</Async>
  );
}
