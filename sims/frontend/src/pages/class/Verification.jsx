import { useMemo, useState } from 'react';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Modal, PageHeader, Pill, StatusChip, Textarea, fmtDate, fmtDateTime, useAction, useLoad } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { ITEM_FIELDS, TYPE_LABEL } from './shared';

const show = (v) => (v == null || v === '' ? '—' : Array.isArray(v) ? (v.length ? v.join(' · ') : '—') : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v) : String(v));

/** Review one item: its details, the certificate file, history — and the three decisions. */
function ReviewModal({ id, onClose, onDone }) {
  const { url } = useClass();
  const d = useLoad(() => api.get(url(`/verifications/${id}`)), [id]);
  const [run, busy] = useAction();
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');

  const decide = (action) => async () => {
    if (action !== 'verify' && remarks.trim().length < 3) { setError('Please write a short reason — the student will see it.'); return; }
    setError('');
    const r = await run(() => api.post(url(`/verifications/${id}/${action}`), { remarks: remarks.trim() || undefined }), action === 'verify' ? 'Verified' : action === 'reject' ? 'Rejected' : 'Sent back for correction');
    if (r) onDone();
  };

  return (
    <Modal open onClose={onClose} title="Review submission" wide>
      <Async state={d}>{({ request: r, item, hasFile, history }) => (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><div className="font-semibold">{r.summary.title}</div><div className="text-sm text-muted">{r.student.name}{r.student.rollNumber ? ` · ${r.student.rollNumber}` : ''} · submitted {fmtDateTime(r.submittedAt)}</div></div>
            <div className="flex items-center gap-2"><Pill tone="brand">{TYPE_LABEL[r.type]?.replace(/s$/, '') || r.type}</Pill><StatusChip status={r.status} /></div>
          </div>
          {r.studentNote && <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-sm"><b>Student’s note:</b> {r.studentNote}</p>}

          {item ? (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {(ITEM_FIELDS[r.type] || []).map(([k, label]) => (
                <div key={k} className={['description', 'address', 'summary', 'bullets'].includes(k) ? 'sm:col-span-2' : ''}>
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-0.5 break-words">{/^https?:\/\//.test(item[k] || '') ? <a href={item[k]} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{item[k]}</a> : show(item[k])}</dd>
                </div>
              ))}
            </dl>
          ) : <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn">The student has withdrawn this item.</p>}

          {hasFile && <Button variant="secondary" size="sm" onClick={() => run(() => api.openFile(url(`/verifications/${id}/file`)))}>Open certificate file</Button>}

          {history.length > 0 && (
            <div><div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Earlier decisions</div>
              <ul className="space-y-1 text-sm">{history.map((h, i) => <li key={i} className="flex gap-2"><StatusChip status={h.status} /><span className="text-muted">{fmtDate(h.reviewed_at)}{h.reviewer_remarks ? ` — ${h.reviewer_remarks}` : ''}</span></li>)}</ul></div>
          )}

          {r.status === 'pending' ? (
            <div className="border-t border-line pt-4">
              <Field label="Remarks" error={error} hint="Optional when verifying. Required to reject or ask for a correction — the student sees it."><Textarea rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button variant="danger" busy={busy} onClick={decide('reject')}>Reject</Button>
                <Button variant="secondary" busy={busy} onClick={decide('request-correction')}>Request correction</Button>
                <Button busy={busy} onClick={decide('verify')}>Verify</Button>
              </div>
            </div>
          ) : <p className="border-t border-line pt-4 text-sm text-muted">Decided {fmtDate(r.reviewedAt)}{r.reviewerRemarks ? ` — “${r.reviewerRemarks}”` : ''}.</p>}
        </div>
      )}</Async>
    </Modal>
  );
}

export default function Verification() {
  const { url, current } = useClass();
  const [type, setType] = useState('');
  const [status, setStatus] = useState('pending');
  const [open, setOpen] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [run, busy] = useAction();
  const q = useLoad(() => api.get(url(`/verifications?status=${status}${type ? `&type=${type}` : ''}&limit=100`)), [current.id, type, status]);

  const items = q.data?.items || [];
  const selectable = useMemo(() => items.filter((i) => i.status === 'pending').map((i) => i.id), [items]);
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = selectable.length > 0 && selectable.every((id) => picked.has(id));

  const bulk = async () => {
    const r = await run(() => api.post(url('/verifications/bulk'), { ids: [...picked], action: 'verify' }));
    if (r) { setPicked(new Set()); q.reload(true); }
    return r;
  };
  const after = () => { setOpen(null); setPicked(new Set()); q.reload(true); };

  const types = Object.entries(q.data?.pendingByType || {});
  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Verification center" subtitle="Only verified items count in analytics, leaderboards and resumes." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => setType('')} className={`rounded-full border px-3 py-1 text-sm ${type === '' ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink'}`}>All{status === 'pending' && q.data ? ` (${q.data.pendingTotal})` : ''}</button>
        {Object.keys(TYPE_LABEL).map((t) => (
          <button key={t} onClick={() => setType(t)} className={`rounded-full border px-3 py-1 text-sm ${type === t ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink'}`}>{TYPE_LABEL[t]}{q.data?.pendingByType?.[t] ? ` (${q.data.pendingByType[t]})` : ''}</button>
        ))}
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPicked(new Set()); }} className="ml-auto rounded-xl border border-line bg-surface px-3 py-1.5 text-sm">
          <option value="pending">Pending</option><option value="verified">Verified</option><option value="rejected">Rejected</option><option value="correction_requested">Needs correction</option><option value="all">All</option>
        </select>
      </div>

      {picked.size > 0 && (
        <div className="sticky top-16 z-20 mb-4 flex items-center justify-between gap-3 rounded-2xl border border-brand/30 bg-brand-soft px-4 py-2.5 text-sm">
          <span><b>{picked.size}</b> selected</span>
          <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button><Button size="sm" busy={busy} onClick={bulk}>Verify selected</Button></div>
        </div>
      )}

      <Async state={q}>{() => items.length === 0 ? (
        <Empty title={status === 'pending' ? 'Nothing to verify 🎉' : 'Nothing here'}>{status === 'pending' ? 'New submissions from your students will appear here.' : 'Try a different filter.'}</Empty>
      ) : (
        <Card pad={false}>
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-xs text-muted">
            {selectable.length > 0 && <label className="flex items-center gap-2"><input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(selectable))} />Select all pending</label>}
            <span className="ml-auto">{items.length} item{items.length === 1 ? '' : 's'}</span>
          </div>
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
                {i.status === 'pending' ? <input type="checkbox" aria-label={`Select ${i.summary.title}`} checked={picked.has(i.id)} onChange={() => toggle(i.id)} /> : <span className="w-[13px]" />}
                <button onClick={() => setOpen(i.id)} className="flex min-w-0 flex-1 items-center gap-4 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{i.summary.title}</span>
                    <span className="block truncate text-xs text-muted">{i.student.name}{i.student.rollNumber ? ` · ${i.student.rollNumber}` : ''}{i.summary.detail ? ` · ${i.summary.detail}` : ''}</span>
                  </span>
                  <Pill tone="brand">{i.typeLabel}</Pill>
                  <span className="hidden w-28 text-right text-xs text-muted sm:block">{fmtDate(i.submittedAt)}</span>
                  <span className="hidden sm:block"><StatusChip status={i.status} /></span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}</Async>

      {open && <ReviewModal id={open} onClose={() => setOpen(null)} onDone={after} />}
    </>
  );
}
