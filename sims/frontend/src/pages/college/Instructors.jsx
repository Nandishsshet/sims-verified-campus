import { useState } from 'react';
import { api } from '../../api';
import { Async, Button, Card, Empty, PageHeader, Pill, Select, fmtDate, fmtDateTime, useAction, useLoad } from '../../ui';
import { Tabs } from '../class/shared';
import { fmtHours } from './shared';

const TONE = { pending: 'warn', approved: 'good', rejected: 'bad', removed: 'muted' };
const GROUPS = { pending: ['pending'], approved: ['approved'], past: ['rejected', 'removed'] };

function Stat({ label, children }) {
  return <div><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div><div className="text-sm font-medium tabular-nums">{children}</div></div>;
}

export default function Instructors() {
  const q = useLoad(() => api.get('/college/instructors'));
  const depts = useLoad(() => api.get('/college/departments'));
  const [tab, setTab] = useState(null);                       // null → pending if any, else approved
  const [run, busy] = useAction();

  const decide = (m, verb) => async () => {
    if (verb === 'remove' && !window.confirm(`Remove ${m.full_name}? Their classes are suspended: students keep their data, but nobody can join and the class leaves the instructor's view.`)) return;
    const msg = { approve: 'Instructor approved', reject: 'Request rejected', remove: 'Instructor removed' }[verb];
    if (await run(() => api.post(`/college/instructors/${m.id}/${verb}`, {}), msg)) q.reload(true);
  };
  const assign = async (m, departmentId) => { if (await run(() => api.patch(`/college/instructors/${m.id}`, { departmentId: departmentId || null }), 'Department updated')) q.reload(true); };

  return (
    <>
      <PageHeader title="Instructors" subtitle="Approve instructors who joined with your College Key and see how each class is being run." />
      <Async state={q}>{({ instructors }) => {
        const by = (g) => instructors.filter((i) => GROUPS[g].includes(i.status));
        const active = tab || (by('pending').length ? 'pending' : 'approved');
        const rows = by(active);
        return (
          <>
            <Tabs value={active} onChange={setTab} tabs={[{ id: 'pending', label: 'Pending', badge: by('pending').length || null }, { id: 'approved', label: `Approved (${by('approved').length})` }, { id: 'past', label: `Rejected & removed (${by('past').length})` }]} />
            {rows.length === 0 ? <Empty title={active === 'pending' ? 'No pending requests' : 'Nobody here'}>{active === 'pending' ? 'Instructors who sign up with your College Key appear here for approval. Share the key from College settings.' : ''}</Empty> : (
              <div className="space-y-3">
                {rows.map((m) => (
                  <Card key={m.id} pad={false}>
                    <div className="flex flex-wrap items-start gap-4 p-5">
                      <div className="min-w-0 flex-1 basis-60">
                        <div className="font-semibold">{m.full_name} <Pill tone={TONE[m.status]}>{m.status}</Pill></div>
                        <div className="truncate text-xs text-muted">{m.email}{m.phone ? ` · ${m.phone}` : ''}</div>
                        <div className="mt-1 text-xs text-muted">{m.status === 'pending' ? `Requested ${fmtDate(m.requested_at)}` : `${m.status === 'approved' ? 'Approved' : 'Decided'} ${fmtDate(m.decided_at)}`}</div>
                      </div>
                      {m.status === 'approved' && (
                        <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
                          <Stat label="Classes">{m.class_count}</Stat>
                          <Stat label="Students">{m.student_count}</Stat>
                          <Stat label="In queue"><span className={m.pending_items > 0 ? 'text-warn' : ''}>{m.pending_items}</span></Stat>
                          <Stat label="Median turnaround">{fmtHours(m.turnaround_hours)}</Stat>
                        </div>
                      )}
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {m.status === 'pending' && <><Button size="sm" busy={busy} onClick={decide(m, 'approve')}>Approve</Button><Button size="sm" variant="secondary" busy={busy} onClick={decide(m, 'reject')}>Reject</Button></>}
                        {m.status === 'approved' && <Button size="sm" variant="ghost" busy={busy} onClick={decide(m, 'remove')}>Remove</Button>}
                      </div>
                    </div>
                    {m.status === 'approved' && (
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-xs text-muted">
                        <label className="flex items-center gap-2">Department
                          <Select aria-label={`Department for ${m.full_name}`} className="!w-auto !py-1.5 text-xs" value={m.department_id || ''} disabled={busy} onChange={(e) => assign(m, e.target.value)}>
                            <option value="">Not assigned</option>{depts.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </Select>
                        </label>
                        <span>Last active {m.last_active ? fmtDateTime(m.last_active) : 'never'}</span>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </>
        );
      }}</Async>
    </>
  );
}
