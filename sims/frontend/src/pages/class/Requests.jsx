import { useState } from 'react';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Select, fmtDate, useAction, useLoad, useToast } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';

const TONE = { pending: 'warn', approved: 'good', rejected: 'bad', removed: 'muted' };

/** Rotate the Class Key (old one stops working immediately) with optional expiry / use limit. */
function KeyModal({ onClose, onDone }) {
  const { classId } = useClass();
  const [run, busy] = useAction();
  const [f, setF] = useState({ expiresAt: '', maxUses: '' });
  const go = async () => {
    const body = { expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null, maxUses: f.maxUses ? Number(f.maxUses) : null };
    if (await run(() => api.post(`/keys/class/${classId}/regenerate`, body), 'New Class Key created')) onDone();
  };
  return (
    <Modal open onClose={onClose} title="Generate a new Class Key">
      <div className="space-y-4">
        <p className="text-sm text-muted">The current key stops working immediately. Students who already joined stay in the class.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expires on (optional)"><Input type="date" min={new Date().toISOString().slice(0, 10)} value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
          <Field label="Max uses (optional)"><Input type="number" min="1" max="100000" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={go}>Generate</Button></div>
      </div>
    </Modal>
  );
}

export default function Requests() {
  const { url, current, reload, classId } = useClass();
  const toast = useToast();
  const [run, busy] = useAction();
  const [status, setStatus] = useState('pending');
  const [rolls, setRolls] = useState({});
  const [rotate, setRotate] = useState(false);
  const list = useLoad(() => api.get(url(`/enrollments?status=${status}`)), [current.id, status]);
  const key = useLoad(() => api.get(url()), [current.id]);

  const after = () => { list.reload(true); key.reload(true); reload(true); };
  const decide = (e, verb) => async () => {
    const roll = (rolls[e.id] ?? e.roll_number ?? '').trim();
    if (verb === 'approve' && !roll) { toast('Add the student’s roll number to approve', 'error'); return; }
    let r;
    if (verb === 'remove') { if (!window.confirm(`Remove ${e.full_name} from the class?`)) return; r = await run(() => api.del(url(`/enrollments/${e.id}`), {}).then(() => true), 'Student removed'); }
    else r = await run(() => api.post(url(`/enrollments/${e.id}/${verb}`), verb === 'approve' ? { rollNumber: roll } : {}), verb === 'approve' ? 'Student approved' : 'Request rejected');
    if (r) after();
  };
  const revoke = async () => { if (window.confirm('Revoke the Class Key? Nobody will be able to join until you generate a new one.') && await run(() => api.post(`/keys/class/${classId}/revoke`, {}), 'Class Key revoked')) after(); };
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast('Class Key copied'); } catch { toast('Copy failed', 'error'); } };

  const k = key.data?.key;
  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Join requests" subtitle="Students need your approval before they can join the class." />

      <Card title="Class Key" className="mb-6">
        <div className="flex flex-wrap items-center gap-4">
          {k ? (
            <>
              <button onClick={() => copy(k.keyValue)} title="Copy" className="rounded-2xl border border-line bg-surface-2 px-5 py-3 font-mono text-xl font-semibold tracking-widest hover:border-brand">{k.keyValue}</button>
              <div className="text-sm text-muted">
                <p>{k.useCount} use{k.useCount === 1 ? '' : 's'}{k.maxUses ? ` of ${k.maxUses}` : ''}</p>
                <p>{k.expiresAt ? `Expires ${fmtDate(k.expiresAt)}` : 'No expiry'}</p>
              </div>
            </>
          ) : <p className="text-sm text-muted">There is no active key, so new students cannot join.</p>}
          <div className="ml-auto flex gap-2">{k && <Button variant="ghost" size="sm" onClick={revoke}>Revoke</Button>}<Button variant="secondary" size="sm" onClick={() => setRotate(true)}>{k ? 'Generate new key' : 'Generate key'}</Button></div>
        </div>
      </Card>

      <div className="mb-4 flex items-center gap-3">
        <Select aria-label="Status" className="!w-auto" value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="removed">Removed</option></Select>
      </div>
      <Async state={list}>{({ enrollments }) => enrollments.length === 0 ? <Empty title={status === 'pending' ? 'No pending requests' : `No ${status} students`}>{status === 'pending' ? 'When a student enters your Class Key, their request shows up here.' : ''}</Empty> : (
        <Card pad={false}>
          <ul className="divide-y divide-line">{enrollments.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1 basis-56"><div className="font-medium">{e.full_name} <Pill tone={TONE[e.status]}>{e.status}</Pill></div><div className="truncate text-xs text-muted">{e.email} · requested {fmtDate(e.requested_at)}</div></div>
              {e.status !== 'approved' ? (
                <Input aria-label={`Roll number for ${e.full_name}`} placeholder="Roll number" maxLength={40} className="!w-36" value={rolls[e.id] ?? e.roll_number ?? ''} onChange={(ev) => setRolls({ ...rolls, [e.id]: ev.target.value })} />
              ) : <span className="text-sm text-muted">{e.roll_number || 'No roll number'}</span>}
              <div className="flex gap-2">
                {e.status !== 'approved' && <Button size="sm" busy={busy} onClick={decide(e, 'approve')}>Approve</Button>}
                {e.status === 'pending' && <Button size="sm" variant="secondary" busy={busy} onClick={decide(e, 'reject')}>Reject</Button>}
                {(e.status === 'approved' || e.status === 'pending') && <Button size="sm" variant="ghost" busy={busy} onClick={decide(e, 'remove')}>Remove</Button>}
              </div>
            </li>
          ))}</ul>
        </Card>
      )}</Async>
      {rotate && <KeyModal onClose={() => setRotate(false)} onDone={() => { setRotate(false); after(); }} />}
    </>
  );
}
