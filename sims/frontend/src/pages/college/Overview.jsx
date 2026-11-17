import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Async, Card, Empty, PageHeader, Pill, Stat, num, useLoad } from '../../ui';
import { ComponentBars, InsightLink, RankBadge, RiskBar, ScoreText, SeverityPill } from './shared';

/** Department → class tree: every department with its rank and score, and its classes underneath. */
function DepartmentTree({ departments }) {
  if (departments.length === 0) return <Empty title="No departments yet" action={<Link to="/college/departments" className="text-sm font-medium text-brand hover:underline">Add your first department</Link>}>Instructors choose a department when they create a class.</Empty>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {departments.map((d) => (
        <Card key={d.id} pad={false}>
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <RankBadge rank={d.rank} />
            <div className="min-w-0 flex-1">
              <Link to={`/college/departments/${d.id}`} className="font-semibold hover:text-brand">{d.name}</Link> <span className="text-xs text-muted">{d.code}</span>
              <div className="text-xs text-muted">{d.hodName ? `HOD ${d.hodName} · ` : ''}{d.students} student{d.students === 1 ? '' : 's'}{d.pending.total > 0 && <> · <span className={d.pending.stale ? 'font-medium text-bad' : ''}>{d.pending.total} awaiting verification{d.pending.stale ? ` (${d.pending.stale} stale)` : ''}</span></>}</div>
            </div>
            <div className="text-right"><div className="text-xs text-muted">Score</div><ScoreText score={d.score} className="text-lg" /></div>
          </div>
          {d.classes.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No classes yet.</p> : (
            <ul className="divide-y divide-line">
              {d.classes.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <div className="min-w-0"><span className="font-medium">{c.name}</span>{c.status !== 'active' && <> <Pill tone="muted">{c.status}</Pill></>}
                    <div className="truncate text-xs text-muted">{c.instructor || 'No instructor'} · semester {c.semester} · {c.students} student{c.students === 1 ? '' : 's'}</div></div>
                  <div className="flex items-center gap-3">{c.pending > 0 && <Pill tone="warn">{c.pending} pending</Pill>}<ScoreText score={c.score} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

export default function Overview() {
  const { context } = useAuth();
  const q = useLoad(() => api.get('/college/overview'));
  const ins = useLoad(() => api.get('/college/insights'));
  return (
    <>
      <PageHeader title={context?.college?.name || 'College dashboard'} subtitle={`${context?.university || ''}${context?.university ? ' · ' : ''}Everything here is calculated from verified data only.`} />
      <Async state={q}>{(o) => (
        <div className="space-y-6">
          {o.totals.pendingInstructors > 0 && (
            <Link to="/college/instructors" className="flex items-center justify-between gap-3 rounded-2xl border border-warn/40 bg-warn-soft px-5 py-3.5 text-sm text-warn hover:opacity-90">
              <span><b>{o.totals.pendingInstructors} instructor request{o.totals.pendingInstructors === 1 ? '' : 's'}</b> waiting for your approval — they cannot create classes until then.</span><span className="font-medium">Review →</span>
            </Link>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Students" value={o.totals.students} />
            <Stat label="Classes" value={o.totals.classes} />
            <Stat label="Instructors" value={o.totals.instructors} hint={o.totals.pendingInstructors ? `${o.totals.pendingInstructors} pending` : null} />
            <Stat label="Departments" value={o.totals.departments} />
            <Stat label="Awaiting review" value={o.totals.pendingVerifications} tone={o.totals.staleVerifications ? 'bad' : 'default'} hint={o.totals.staleVerifications ? `${o.totals.staleVerifications} older than 7 days` : 'in instructors’ queues'} />
            <Link to="/college/alerts" className="block"><Stat label="Classes flagged" value={o.alertCount} tone={o.alertCount ? 'warn' : 'good'} hint="open alerts →" /></Link>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="College score" className="lg:col-span-2" action={<Link to="/college/analytics" className="text-xs font-medium text-brand hover:underline">Analytics →</Link>}>
              {o.score.value == null ? <p className="text-sm text-muted">No verified attendance or marks yet — the college score appears as soon as instructors verify data.</p> : (
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
              <div className="border-t border-line px-5 py-2.5 text-right"><Link to="/college/alerts" className="text-xs font-medium text-brand hover:underline">All alerts & insights →</Link></div>
            </Card>
          </div>

          <section>
            <h2 className="mb-3 text-sm font-semibold tracking-tight">Departments and classes</h2>
            <DepartmentTree departments={o.departments} />
          </section>

          <Card title="Top students in the college" pad={false} action={<Link to="/college/leaderboard" className="text-xs font-medium text-brand hover:underline">Full leaderboard →</Link>}>
            {o.topStudents.length === 0 ? <p className="p-5 text-sm text-muted">No ranked students yet.</p> : (
              <ul className="divide-y divide-line">{o.topStudents.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3 text-sm"><RankBadge rank={s.rank} /><div className="min-w-0 flex-1"><div className="font-medium">{s.name}</div><div className="truncate text-xs text-muted">{s.class}</div></div><b className="tabular-nums">{num(s.score)}</b></li>
              ))}</ul>
            )}
          </Card>
        </div>
      )}</Async>
    </>
  );
}
