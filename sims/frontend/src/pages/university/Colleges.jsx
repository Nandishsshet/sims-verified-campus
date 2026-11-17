import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, PageHeader, fmtDate, useAction, useLoad, useToast } from '../../ui';
import { StatusPill } from './shared';

/** A registration waiting for a decision. Approving issues the College Key. */
function PendingCard({ c, onChanged }) {
  const [run, busy] = useAction();
  const approve = async () => { if (await run(() => api.post(`/university/colleges/${c.id}/approve`, {}), `${c.name} approved — College Key issued`)) onChanged(); };
  return (
    <Card pad={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <div className="font-semibold">{c.name}</div>
          <div className="text-xs text-muted">{c.principal_name ? `Principal ${c.principal_name} · ` : ''}Admin {c.admin_name} ({c.admin_email}) · registered {fmtDate(c.created_at)}</div>
          {c.affiliation && <div className="text-xs text-muted">Affiliation: {c.affiliation}</div>}
        </div>
        <Button busy={busy} onClick={approve}>Approve college</Button>
      </div>
    </Card>
  );
}

/** Suspend / reinstate with a confirmation (suspension blocks every instructor and student of the college). */
function Actions({ c, onChanged }) {
  const [run, busy] = useAction();
  const toast = useToast();
  const act = (verb, message, confirmText) => async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    if (await run(() => api.post(`/university/colleges/${c.id}/${verb}`, {}), message)) onChanged();
  };
  const copy = async () => { try { await navigator.clipboard.writeText(c.key_value); toast('College Key copied'); } catch { toast('Copy failed', 'error'); } };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {c.key_value && <button onClick={copy} title="Copy College Key" className="rounded-lg border border-line bg-surface-2 px-2.5 py-1 font-mono text-xs font-semibold tracking-wider hover:border-brand">{c.key_value}</button>}
      <Link to={`/university/colleges/${c.id}`} className="text-xs font-medium text-brand hover:underline">Details →</Link>
      {c.status === 'active' && <Button size="sm" variant="ghost" busy={busy} onClick={act('suspend', `${c.name} suspended`, `Suspend ${c.name}? Its instructors and students are blocked immediately, and it drops out of every ranking and total until you reinstate it.`)}>Suspend</Button>}
      {c.status === 'suspended' && <Button size="sm" variant="secondary" busy={busy} onClick={act('reinstate', `${c.name} reinstated`)}>Reinstate</Button>}
    </div>
  );
}

export default function Colleges() {
  const q = useLoad(() => api.get('/university/colleges'));
  return (
    <>
      <PageHeader title="Colleges" subtitle="Approve registrations, share College Keys and suspend or reinstate colleges." />
      <Async state={q}>{({ colleges }) => {
        const pending = colleges.filter((c) => c.status === 'pending');
        const rest = colleges.filter((c) => c.status !== 'pending');
        return colleges.length === 0 ? <Empty title="No college has registered yet">Share your University Key (Settings) with college administrators. Their registrations appear here for your approval.</Empty> : (
          <div className="space-y-6">
            {pending.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold tracking-tight">Waiting for approval ({pending.length})</h2>
                <div className="space-y-3">{pending.map((c) => <PendingCard key={c.id} c={c} onChanged={() => q.reload(true)} />)}</div>
              </section>
            )}
            <section>
              <h2 className="mb-3 text-sm font-semibold tracking-tight">All colleges ({rest.length})</h2>
              {rest.length === 0 ? <p className="text-sm text-muted">Approved colleges appear here.</p> : (
                <Card pad={false}>
                  <ul className="divide-y divide-line">
                    {rest.map((c) => (
                      <li key={c.id} className="space-y-2 px-5 py-4 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0"><Link to={`/university/colleges/${c.id}`} className="font-semibold hover:text-brand">{c.name}</Link> <StatusPill status={c.status} />
                            <div className="text-xs text-muted">Admin {c.admin_name} · {c.approved_at ? `approved ${fmtDate(c.approved_at)}` : `registered ${fmtDate(c.created_at)}`}</div></div>
                          <Actions c={c} onChanged={() => q.reload(true)} />
                        </div>
                        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                          <span><b className="tabular-nums text-ink">{c.student_count}</b> students</span><span><b className="tabular-nums text-ink">{c.instructor_count}</b> instructors{c.pending_instructors ? ` (+${c.pending_instructors} pending)` : ''}</span>
                          <span><b className="tabular-nums text-ink">{c.department_count}</b> departments</span><span><b className="tabular-nums text-ink">{c.class_count}</b> classes</span>
                          {c.key_value && <span>Key used {c.use_count} time{c.use_count === 1 ? '' : 's'}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <p className="mt-3 text-xs text-muted">A suspended college keeps its data and its key but nobody in it can sign in to the dashboards until it is reinstated. A registration cannot be rejected — leave it pending, or suspend it after approval.</p>
            </section>
          </div>
        );
      }}</Async>
    </>
  );
}
