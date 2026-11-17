import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, num, useLoad } from '../../ui';
import { InsightLink, SeverityPill } from '../college/shared';

export default function Alerts() {
  const alerts = useLoad(() => api.get('/university/alerts'));
  const ins = useLoad(() => api.get('/university/insights'));
  return (
    <>
      <PageHeader title="Alerts & insights" subtitle="Which colleges need attention, with the numbers behind every line." />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">Colleges that need attention</h2>
          <Async state={alerts}>{({ alerts: list, staleAfterDays }) => list.length === 0 ? (
            <Empty title="No college is flagged 🎉">A college is flagged for average attendance under 75%, 30% or more students at medium or high dropout risk, fewer than 70% of students without backlogs, no verified data, or verifications waiting more than {staleAfterDays} days.</Empty>
          ) : (
            <div className="space-y-3">
              {list.map((a) => (
                <Card key={a.id} pad={false}>
                  <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                    <div className="min-w-0"><Link to={`/university/colleges/${a.id}`} className="font-semibold hover:text-brand">{a.name}</Link><div className="text-xs text-muted">{a.students} student{a.students === 1 ? '' : 's'}</div></div>
                    <SeverityPill severity={a.severity} />
                  </div>
                  <ul className="space-y-1.5 border-t border-line px-5 py-3.5 text-sm">
                    {a.reasons.map((r) => <li key={r} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-warn" />{r}</li>)}
                  </ul>
                  <div className="flex flex-wrap items-center gap-4 border-t border-line px-5 py-2.5 text-xs text-muted">
                    <span>Attendance {a.attendancePct != null ? `${num(a.attendancePct)}%` : '—'}</span>
                    <span>{a.pending.total} in queues{a.pending.stale ? <> · <b className="text-bad">{a.pending.stale} stale</b></> : ''}</span>
                    <Link to={`/university/colleges/${a.id}`} className="ml-auto font-medium text-brand hover:underline">College details →</Link>
                  </div>
                </Card>
              ))}
            </div>
          )}</Async>
        </div>

        <div className="lg:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-tight">Insights <Pill tone="muted">rule-based</Pill></h2>
          <Async state={ins}>{({ insights }) => (
            <Card pad={false}>
              <ul className="divide-y divide-line">
                {insights.map((i) => (
                  <li key={i.id} className="px-5 py-4 text-sm">
                    <div className="mb-1"><SeverityPill severity={i.severity} /></div>
                    <div className="font-medium">{i.title}</div>
                    <p className="mt-0.5 text-xs text-muted">{i.detail}</p>
                    <div className="mt-1"><InsightLink to={i.to}>Open →</InsightLink></div>
                  </li>
                ))}
              </ul>
              <p className="border-t border-line px-5 py-3 text-xs text-muted">Generated from fixed rules over verified data — no AI model is involved, and each line cites the figures it is based on.</p>
            </Card>
          )}</Async>
        </div>
      </div>
    </>
  );
}
