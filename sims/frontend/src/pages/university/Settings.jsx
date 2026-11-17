import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Async, Button, Card, Field, Input, Modal, PageHeader, fmtDate, useAction, useLoad, useToast } from '../../ui';

/** Rotate the University Key: the old one stops working at once; colleges that already registered are unaffected. */
function KeyModal({ universityId, onClose, onDone }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ expiresAt: '', maxUses: '' });
  const go = async () => {
    const body = { expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null, maxUses: f.maxUses ? Number(f.maxUses) : null };
    if (await run(() => api.post(`/keys/university/${universityId}/regenerate`, body), 'New University Key created')) onDone();
  };
  return (
    <Modal open onClose={onClose} title="Generate a new University Key">
      <div className="space-y-4">
        <p className="text-sm text-muted">The current key stops working immediately. Colleges that already registered stay in the university.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expires on (optional)"><Input type="date" min={new Date().toISOString().slice(0, 10)} value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
          <Field label="Max uses (optional)"><Input type="number" min="1" max="100000" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={go}>Generate</Button></div>
      </div>
    </Modal>
  );
}

function Profile({ university, onSaved }) {
  const { refresh } = useAuth();
  const [f, setF] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { setF({ name: university.name || '', headTitle: university.head_title || '', headName: university.head_name || '', address: university.address || '', contactEmail: university.contact_email || '', contactPhone: university.contact_phone || '' }); }, [university]);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const blank = (v) => (v.trim() ? v.trim() : null);                 // optional fields: empty clears them

  const save = async (e) => {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api.patch('/university', { name: f.name, headTitle: f.headTitle, headName: f.headName, address: blank(f.address), contactEmail: blank(f.contactEmail), contactPhone: blank(f.contactPhone) });
      toast('University profile saved'); await refresh(); onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Card title="University profile">
      <form onSubmit={save} className="space-y-4">
        {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="University name" error={error?.fields?.name}><Input required minLength={2} maxLength={160} value={f.name ?? ''} onChange={set('name')} /></Field>
          <Field label="Head’s name" error={error?.fields?.headName}><Input required minLength={2} maxLength={120} value={f.headName ?? ''} onChange={set('headName')} /></Field>
          <Field label="Head’s title" error={error?.fields?.headTitle}><Input required minLength={2} maxLength={60} value={f.headTitle ?? ''} onChange={set('headTitle')} /></Field>
          <Field label="Contact phone" error={error?.fields?.contactPhone}><Input maxLength={30} value={f.contactPhone ?? ''} onChange={set('contactPhone')} /></Field>
          <Field label="Contact e-mail" error={error?.fields?.contactEmail}><Input type="email" value={f.contactEmail ?? ''} onChange={set('contactEmail')} /></Field>
          <Field label="Address" error={error?.fields?.address}><Input maxLength={300} value={f.address ?? ''} onChange={set('address')} /></Field>
        </div>
        <div className="flex justify-end"><Button type="submit" busy={busy}>Save changes</Button></div>
      </form>
    </Card>
  );
}

export default function Settings() {
  const q = useLoad(() => api.get('/university'));
  const toast = useToast();
  const [run] = useAction();
  const [rotate, setRotate] = useState(false);

  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast('University Key copied'); } catch { toast('Copy failed', 'error'); } };
  const revoke = (id) => async () => { if (window.confirm('Revoke the University Key? No new college can register until you generate a new one.') && await run(() => api.post(`/keys/university/${id}/revoke`, {}), 'University Key revoked')) q.reload(true); };

  return (
    <>
      <PageHeader title="University settings" subtitle="Your profile and the key colleges use to register." />
      <Async state={q}>{({ university, key: k }) => (
        <div className="space-y-6">
          <Card title="University Key">
            <div className="flex flex-wrap items-center gap-4">
              {k ? (
                <>
                  <button onClick={() => copy(k.keyValue)} title="Copy" className="rounded-2xl border border-line bg-surface-2 px-5 py-3 font-mono text-xl font-semibold tracking-widest hover:border-brand">{k.keyValue}</button>
                  <div className="text-sm text-muted"><p>{k.useCount} use{k.useCount === 1 ? '' : 's'}{k.maxUses ? ` of ${k.maxUses}` : ''}</p><p>{k.expiresAt ? `Expires ${fmtDate(k.expiresAt)}` : 'No expiry'}</p></div>
                </>
              ) : <p className="text-sm text-muted">There is no active key, so new colleges cannot register.</p>}
              <div className="ml-auto flex gap-2">{k && <Button variant="ghost" size="sm" onClick={revoke(university.id)}>Revoke</Button>}<Button variant="secondary" size="sm" onClick={() => setRotate(true)}>{k ? 'Generate new key' : 'Generate key'}</Button></div>
            </div>
            <p className="mt-3 text-xs text-muted">Share this key with college administrators. Each one signs up with it and you approve the college on the Colleges page before anyone in it can start.</p>
          </Card>
          <Profile university={university} onSaved={() => q.reload(true)} />
          {rotate && <KeyModal universityId={university.id} onClose={() => setRotate(false)} onDone={() => { setRotate(false); q.reload(true); }} />}
        </div>
      )}</Async>
    </>
  );
}
