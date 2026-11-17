import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Async, Button, Card, Field, Input, Modal, PageHeader, fmtDate, useAction, useLoad, useToast } from '../../ui';

/** Rotate the College Key (the old one stops working immediately); instructors who already joined are unaffected. */
function KeyModal({ collegeId, onClose, onDone }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ expiresAt: '', maxUses: '' });
  const go = async () => {
    const body = { expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null, maxUses: f.maxUses ? Number(f.maxUses) : null };
    if (await run(() => api.post(`/keys/college/${collegeId}/regenerate`, body), 'New College Key created')) onDone();
  };
  return (
    <Modal open onClose={onClose} title="Generate a new College Key">
      <div className="space-y-4">
        <p className="text-sm text-muted">The current key stops working immediately. Instructors who already joined stay in the college.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expires on (optional)"><Input type="date" min={new Date().toISOString().slice(0, 10)} value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
          <Field label="Max uses (optional)"><Input type="number" min="1" max="100000" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={go}>Generate</Button></div>
      </div>
    </Modal>
  );
}

function Profile({ college, onSaved }) {
  const { refresh } = useAuth();
  const [f, setF] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { setF({ name: college.name || '', principalName: college.principal_name || '', affiliation: college.affiliation || '', address: college.address || '', contactEmail: college.contact_email || '', contactPhone: college.contact_phone || '' }); }, [college]);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const blank = (v) => (v.trim() ? v.trim() : null);                 // optional fields: empty clears them

  const save = async (e) => {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api.patch('/college', { name: f.name, principalName: f.principalName, affiliation: blank(f.affiliation), address: blank(f.address), contactEmail: blank(f.contactEmail), contactPhone: blank(f.contactPhone) });
      toast('College profile saved'); await refresh(); onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Card title="College profile">
      <form onSubmit={save} className="space-y-4">
        {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="College name" error={error?.fields?.name}><Input required minLength={2} maxLength={160} value={f.name ?? ''} onChange={set('name')} /></Field>
          <Field label="Principal" error={error?.fields?.principalName}><Input required minLength={2} maxLength={120} value={f.principalName ?? ''} onChange={set('principalName')} /></Field>
          <Field label="Affiliation" error={error?.fields?.affiliation}><Input maxLength={160} value={f.affiliation ?? ''} onChange={set('affiliation')} /></Field>
          <Field label="Contact phone" error={error?.fields?.contactPhone}><Input maxLength={30} value={f.contactPhone ?? ''} onChange={set('contactPhone')} /></Field>
          <Field label="Contact e-mail" error={error?.fields?.contactEmail}><Input type="email" value={f.contactEmail ?? ''} onChange={set('contactEmail')} /></Field>
          <Field label="Address" error={error?.fields?.address}><Input maxLength={300} value={f.address ?? ''} onChange={set('address')} /></Field>
        </div>
        <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted">University: <b className="text-ink">{college.university}</b> (set by the University Head)</span><Button type="submit" busy={busy}>Save changes</Button></div>
      </form>
    </Card>
  );
}

export default function Settings() {
  const q = useLoad(() => api.get('/college'));
  const toast = useToast();
  const [run] = useAction();
  const [rotate, setRotate] = useState(false);

  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast('College Key copied'); } catch { toast('Copy failed', 'error'); } };
  const revoke = (id) => async () => { if (window.confirm('Revoke the College Key? No new instructor can join until you generate a new one.') && await run(() => api.post(`/keys/college/${id}/revoke`, {}), 'College Key revoked')) q.reload(true); };

  return (
    <>
      <PageHeader title="College settings" subtitle="Your profile and the key instructors use to join." />
      <Async state={q}>{({ college, key: k }) => (
        <div className="space-y-6">
          <Card title="College Key">
            <div className="flex flex-wrap items-center gap-4">
              {k ? (
                <>
                  <button onClick={() => copy(k.keyValue)} title="Copy" className="rounded-2xl border border-line bg-surface-2 px-5 py-3 font-mono text-xl font-semibold tracking-widest hover:border-brand">{k.keyValue}</button>
                  <div className="text-sm text-muted"><p>{k.useCount} use{k.useCount === 1 ? '' : 's'}{k.maxUses ? ` of ${k.maxUses}` : ''}</p><p>{k.expiresAt ? `Expires ${fmtDate(k.expiresAt)}` : 'No expiry'}</p></div>
                </>
              ) : <p className="text-sm text-muted">There is no active key, so new instructors cannot join.</p>}
              <div className="ml-auto flex gap-2">{k && <Button variant="ghost" size="sm" onClick={revoke(college.id)}>Revoke</Button>}<Button variant="secondary" size="sm" onClick={() => setRotate(true)}>{k ? 'Generate new key' : 'Generate key'}</Button></div>
            </div>
            <p className="mt-3 text-xs text-muted">Share this key with your instructors. Each one signs up with it and you approve them on the Instructors page before they can create classes.</p>
          </Card>
          <Profile college={college} onSaved={() => q.reload(true)} />
          {rotate && <KeyModal collegeId={college.id} onClose={() => setRotate(false)} onDone={() => { setRotate(false); q.reload(true); }} />}
        </div>
      )}</Async>
    </>
  );
}
