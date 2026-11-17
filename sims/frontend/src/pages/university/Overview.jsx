import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Async, Card, Empty, PageHeader, Pill, Stat, num, useLoad } from '../../ui';
import { ComponentBars, InsightLink, METRICS, RankBadge, RiskBar, ScoreText, SeverityPill } from '../college/shared';

/** Colleges ranked by score; colleges without verified data are listed last and unranked. */
function CollegeTable({ colleges }) {
  if (colleges.length === 0) return <Empty title="No active college yet" action={<Link to="/university/colleges" className="text-sm font-medium text-brand hover:underline">Open colleges</Link>}>Approve a college registration to see it ranked here.</Empty>;
  return (
    <Card pad={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">College</th><th className="px-3 py-3 text-right">Students</th><th className="px-3 py-3 text-right">Depts / classes</th><th className="px-3 py-3">Weak areas</th><th className="px-3 py-3 text-right">Awaiting review</th><th className="px-4 py-3 text-right">Score</th></tr></thead>
          <tbody className="divide-y divide-line">
            {colleges.map((c) => (
              <tr key={c.id} className="hover:bg-surface-2/60">
                <td className="px-4 py-3"><RankBadge rank={c.rank} /></td>
                <td className="px-4 py-3"><Link to={`/university/colleges/${c.id}`} className="font-medium hover:text-brand">{c.name}</Link>{c.alerts && <> <SeverityPill severity={c.alerts} /></>}</td>
                <td className="px-3 py-3 text-right tabular-nums">{c.students}</td>
                <td className="px-3 py-3 text-right tabular-nums text-muted">{c.departments} / {c.classes}</td>
                <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{c.weak.length ? c.weak.map((k) => <Pill key={k} tone="bad">{METRICS[k]}</Pill>) : <span className="text-muted">—</span>}</div></td>
                <td className={`px-3 py-3 text-right tabular-nums ${c.pending.stale ? 'font-medium text-bad' : ''}`}>{c.pending.total}{c.pending.stale ? ` (${c.pending.stale} stale)` : ''}</td>
                <td className="px-4 py-3 text-right"><ScoreText score={c.score} className="text-base" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function Overview() {
  const { context } = useAuth();
  const q = useLoad(() => api.get('/university/overview'));
  const ins = useLoad(() => api.get('/university/insights'));
  const name = context?.university?.name;
  return (
    <>
      <PageHeader title={name || 'University dashboard'} subtitle="Every figure is calculated from verified data only and rolled up from the colleges below." />
      <Async state={q}>{(o) => (
        <div className="space-y-6">
          {o.pendingColleges.length > 0 && (
            <Link to="/university/colleges" className="flex items-center justify-between gap-3 rounded-2xl border border-warn/40 bg-warn-soft px-5 py-3.5 text-sm text-warn hover:opacity-90">
              <span><b>{o.pendingColleges.length} college registration{o.pendingColleges.length === 1 ? '' : 's'}</b> waiting for your approval{o.pendingColleges.length <= 2 ? `: ${o.pendingColleges.map((c) => c.name).join(', ')}` : ''} — their staff cannot start until then.</span><span className="font-medium">Review →</span>
            </Link>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Colleges" value={o.totals.colleges.active} hint={o.totals.colleges.total > o.totals.colleges.active ? `${o.totals.colleges.total} registered` : 'all active'} />
            <Stat label="Students" value={o.totals.students} />
            <Stat label="Instructors" value={o.totals.instructors} hint={o.totals.pendingInstructors ? `${o.totals.pendingInstructors} pending at colleges` : null} />
            <Stat label="Departments" value={o.totals.departments} hint={`${o.totals.classes} active classes`} />
            <Stat label="Awaiting review" value={o.totals.pendingVerifications} tone={o.totals.staleVerifications ? 'bad' : 'default'} hint={o.totals.staleVerifications ? `${o.totals.staleVerifications} older than 7 days` : 'in instructors’ queues'} />
            <Link to="/university/alerts" className="block"><Stat label="Colleges flagged" value={o.alertCount} tone={o.alertCount ? 'warn' : 'good'} hint="open alerts →" /></Link>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="University score" className="lg:col-span-2" action={<Link to="/university/analytics" className="text-xs font-medium text-brand hover:underline">Analytics →</Link>}>
              {o.score.value == null ? <p className="text-sm text-muted">No verified attendance or marks yet — the university score appears as soon as instructors verify data.</p> : (
                <div className="grid gap-6 md:grid-cols-[10rem_1fr]">
                  <div className="text-center md:text-left">
                    <div className="text-5xl font-semibold tabular-nums tracking-tight text-brand">{num(o.score.value)}</div>
                    <div className="mt-1 text-xs text-muted">out of 100 · {o.score.coverage.withMarks} of {o.totals.students} students have verified marks</div>
                    {o.score.weak.length > 0 && <div className="mt-3"><Pill tone="bad">{o.score.weak.length} weak area{o.score.weak.length === 1 ? '' : 's'}</Pill></div>}
                  </div>
                  <ComponentBars components={o.score.components} weak={o.score.weak} />
                </div>
              )}
              <div className="mt-6 border-t border-line pt-4"><div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Dropout risk</div><RiskBar risk={o.risk} /></div>
            </Card>

            <Card title="Insights" pad={false} action={<Pill tone="muted">rule-based</Pill>}>
              <Async state={ins}>{({ insights }) => (
                <ul className="divide-y divide-line">
                  {insights.slice(0, 6).map((i) => (
                    <li key={i.id} className="px-5 py-3.5 text-sm">
                      <div className="mb-1"><SeverityPill severity={i.severity} /></div>
                      <div className="font-medium">{i.title}</div>
                      <p className="mt-0.5 text-xs text-muted">{i.detail}</p>
                      <div className="mt-1"><InsightLink to={i.to}>Open →</InsightLink></div>
                    </li>
                  ))}
                </ul>
              )}</Async>
              <div className="border-t border-line px-5 py-2.5 text-right"><Link to="/university/alerts" className="text-xs font-medium text-brand hover:underline">All alerts & insights →</Link></div>
            </Card>
          </div>

          <section>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold tracking-tight">College ranking</h2><Link to="/university/leaderboard" className="text-xs font-medium text-brand hover:underline">Leaderboards →</Link></div>
            <CollegeTable colleges={o.colleges} />
            {o.inactiveColleges.some((c) => c.status === 'suspended') && <p className="mt-2 text-xs text-muted">Suspended colleges are not ranked and do not count towards any figure on this page.</p>}
          </section>

          <Card title="Top students in the university" pad={false} action={<Link to="/university/leaderboard?tab=students" className="text-xs font-medium text-brand hover:underline">Full leaderboard →</Link>}>
            {o.topStudents.length === 0 ? <p className="p-5 text-sm text-muted">No ranked students yet.</p> : (
              <ul className="divide-y divide-line">{o.topStudents.map((s) => (
                <li key={`${s.rank}${s.name}`} className="flex items-center gap-3 px-5 py-3 text-sm"><RankBadge rank={s.rank} /><div className="min-w-0 flex-1"><div className="font-medium">{s.name}</div><div className="truncate text-xs text-muted">{s.college}</div></div><b className="tabular-nums">{num(s.score)}</b></li>
              ))}</ul>
            )}
          </Card>
        </div>
      )}</Async>
    </>
  );
}
