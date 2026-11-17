import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../api';
import { Icon } from '../../icons';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Select, StatusChip, fmtDate, useAction, useLoad } from '../../ui';
import { SkillPicker } from './shared';

const CATS = ['course', 'hackathon', 'internship', 'sports', 'workshop', 'other'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function CertForm({ open, onClose, onDone, edit }) {
  const [run, busy] = useAction();
  const [f, setF] = useState(() => ({
    title: edit?.title || '', category: edit?.category || 'course', issuer: edit?.issuer || '',
    issueDate: edit?.issueDate?.slice(0, 10) || '', credentialUrl: edit?.credentialUrl || '', skills: edit?.skills?.map(({ skillId, proficiency }) => ({ skillId, proficiency })) || [],
  }));
  const [file, setFile] = useState(null);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(async () => {
      if (edit) {
        await api.patch(`/student/certificates/${edit.id}`, { title: f.title, category: f.category, issuer: f.issuer, ...(f.issueDate ? { issueDate: f.issueDate } : {}), ...(f.credentialUrl ? { credentialUrl: f.credentialUrl } : {}) });
        await api.put(`/student/certificates/${edit.id}/skills`, { skills: f.skills });
      } else {
        const form = new FormData();
        form.append('title', f.title); form.append('category', f.category); form.append('issuer', f.issuer);
        if (f.issueDate) form.append('issueDate', f.issueDate);
        if (f.credentialUrl) form.append('credentialUrl', f.credentialUrl);
        form.append('skills', JSON.stringify(f.skills));
        form.append('file', file);
        await api.upload('/student/certificates', form);
      }
      return true;
    }, edit ? 'Updated — sent back for verification' : 'Uploaded — your instructor will verify it');
    if (ok) { onDone(); onClose(); }
  };

  return (
    <Modal open={open} onClose={onClose} title={edit ? 'Edit certificate' : 'Upload a certificate'} wide>
      <form onSubmit={submit} className="space-y-4">
        {edit && <p className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">Editing sends this certificate back to your instructor for verification, and its QR code stops working until then.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title"><Input required minLength={2} maxLength={200} value={f.title} onChange={set('title')} /></Field>
          <Field label="Issued by"><Input required minLength={2} maxLength={200} value={f.issuer} onChange={set('issuer')} placeholder="Coursera, NPTEL…" /></Field>
          <Field label="Category"><Select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c} value={c}>{cap(c)}</option>)}</Select></Field>
          <Field label="Issue date"><Input type="date" max={new Date().toISOString().slice(0, 10)} value={f.issueDate} onChange={set('issueDate')} /></Field>
        </div>
        <Field label="Credential link (optional)"><Input type="url" placeholder="https://…" value={f.credentialUrl} onChange={set('credentialUrl')} /></Field>
        {!edit && <Field label="Certificate file" hint="PDF, PNG or JPG · max 5 MB. The file type is checked on the server."><Input type="file" required accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files[0])} className="file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1 file:text-brand" /></Field>}
        <div><span className="mb-1.5 block text-sm font-medium">Skills this proves</span><SkillPicker value={f.skills} onChange={(skills) => setF((p) => ({ ...p, skills }))} /><p className="mt-1.5 text-xs text-muted">These skills count as <b>verified</b> in your skill gap once the certificate is verified.</p></div>
        <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>{edit ? 'Save changes' : 'Upload'}</Button></div>
      </form>
    </Modal>
  );
}

function QRModal({ cert, onClose }) {
  const url = cert ? `${window.location.origin}/verify/${cert.verificationCode}` : '';
  return (
    <Modal open={Boolean(cert)} onClose={onClose} title="Verification QR code">
      {cert && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-2xl border border-line bg-white p-4"><QRCodeSVG value={url} size={200} level="M" /></div>
          <div><p className="font-medium">{cert.title}</p><p className="mt-1 font-mono text-sm tracking-wider text-muted">{cert.verificationCode}</p></div>
          <p className="max-w-sm text-sm text-muted">Anyone — a recruiter, for instance — can scan this to confirm the certificate was verified by your institution. It shows only your name, the title and the issuer.</p>
          <div className="flex gap-2"><Button variant="secondary" onClick={() => navigator.clipboard?.writeText(url)}>Copy link</Button><Button onClick={() => window.open(url, '_blank', 'noopener')}>Open page</Button></div>
        </div>
      )}
    </Modal>
  );
}

export default function Certificates() {
  const s = useLoad(() => api.get('/student/certificates'));
  const [form, setForm] = useState(null);        // null | {} (new) | cert (edit)
  const [qr, setQr] = useState(null);
  const [filter, setFilter] = useState('all');
  const [run] = useAction();

  const remove = (c) => confirm(`Delete “${c.title}”? This cannot be undone.`) && run(async () => { await api.del(`/student/certificates/${c.id}`); s.reload(true); }, 'Certificate deleted');
  const resubmit = (c) => run(async () => { await api.post(`/student/certificates/${c.id}/submit`); s.reload(true); }, 'Resubmitted for verification');

  return (
    <>
      <PageHeader title="Certificates" subtitle="Upload proof of courses, hackathons and more. Verified certificates count in your resume, skills and ranking."
        action={<Button onClick={() => setForm({})}><Icon name="upload" className="size-4" />Upload certificate</Button>} />
      <Async state={s}>{(d) => {
        const list = d.certificates.filter((c) => filter === 'all' || c.status === filter);
        return (<>
          <div className="mb-4 flex flex-wrap gap-2">{['all', 'verified', 'pending', 'rejected', 'correction_requested'].map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === k ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:bg-surface-2'}`}>
              {k === 'all' ? 'All' : k === 'correction_requested' ? 'Needs correction' : cap(k)} ({k === 'all' ? d.certificates.length : d.certificates.filter((c) => c.status === k).length})</button>
          ))}</div>
          {list.length === 0 ? <Empty title={d.certificates.length ? 'No certificates in this filter' : 'No certificates yet'} action={!d.certificates.length && <Button onClick={() => setForm({})}>Upload your first</Button>}>Add certificates from courses, workshops, hackathons or sports.</Empty> : (
            <div className="grid gap-4 md:grid-cols-2">{list.map((c) => (
              <Card key={c.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><h3 className="font-semibold leading-snug">{c.title}</h3><p className="mt-0.5 text-sm text-muted">{c.issuer} · {fmtDate(c.issueDate)}</p></div>
                  <StatusChip status={c.status} />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5"><Pill tone="brand">{cap(c.category)}</Pill>{c.skills.map((k) => <Pill key={k.skillId}>{k.name}</Pill>)}</div>
                {c.remarks && c.status !== 'verified' && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-sm"><b>Instructor:</b> {c.remarks}</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => run(() => api.openFile(`/student/certificates/${c.id}/file`))}>View file</Button>
                  {c.verificationCode && <Button size="sm" variant="secondary" onClick={() => setQr(c)}>QR code</Button>}
                  {(c.status === 'rejected' || c.status === 'correction_requested') && <Button size="sm" onClick={() => resubmit(c)}>Resubmit</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setForm(c)}><Icon name="edit" className="size-4" />Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(c)} aria-label={`Delete ${c.title}`}><Icon name="trash" className="size-4 text-bad" /></Button>
                </div>
              </Card>
            ))}</div>
          )}
        </>);
      }}</Async>
      {form && <CertForm key={form.id || 'new'} open edit={form.id ? form : null} onClose={() => setForm(null)} onDone={() => s.reload(true)} />}
      <QRModal cert={qr} onClose={() => setQr(null)} />
    </>
  );
}
