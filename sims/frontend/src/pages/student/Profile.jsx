import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Async, Button, Card, Field, Input, PageHeader, Select, StatusChip, Textarea, fmtDate, useAction, useLoad } from '../../ui';

const blank = (v) => v ?? '';

function Photo({ hasPhoto, onChange }) {
  const [url, setUrl] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => {
    let revoke;
    if (hasPhoto) api.get('/student/profile/photo').then((b) => { revoke = URL.createObjectURL(b); setUrl(revoke); }).catch(() => setUrl(null));
    else setUrl(null);
    return () => revoke && URL.revokeObjectURL(revoke);
  }, [hasPhoto]);
  const pick = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const form = new FormData(); form.append('file', file);
    run(async () => { await api.upload('/student/profile/photo', form); onChange(); }, 'Photo updated');
    e.target.value = '';
  };
  return (
    <div className="flex items-center gap-4">
      <div className="flex size-20 items-center justify-center overflow-hidden rounded-2xl bg-brand-soft text-2xl font-semibold text-brand">{url ? <img src={url} alt="Your profile" className="size-full object-cover" /> : '👤'}</div>
      <div><label className={`inline-flex cursor-pointer items-center rounded-xl border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2 ${busy ? 'opacity-50' : ''}`}>Change photo<input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={pick} disabled={busy} /></label><p className="mt-1 text-xs text-muted">JPG or PNG, up to 1 MB</p></div>
    </div>
  );
}

export default function Profile() {
  const { refresh, context } = useAuth();
  const s = useLoad(() => api.get('/student/profile'));
  const [run, busy] = useAction();
  const [f, setF] = useState(null);

  useEffect(() => {
    if (!s.data) return;
    const p = s.data.profile;
    setF({ fullName: p.fullName, phone: blank(p.phone), dateOfBirth: blank(p.dateOfBirth?.slice(0, 10)), gender: blank(p.gender), address: blank(p.address), guardianName: blank(p.guardianName), guardianEmail: blank(p.guardianEmail), guardianPhone: blank(p.guardianPhone), summary: blank(p.summary), linkedinUrl: blank(p.linkedinUrl), githubUrl: blank(p.githubUrl) });
  }, [s.data]);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    const n = (v) => (v === '' ? null : v);
    await run(async () => {
      await api.patch('/student/profile', { fullName: f.fullName, phone: n(f.phone), dateOfBirth: n(f.dateOfBirth), gender: n(f.gender), address: n(f.address), guardianName: n(f.guardianName), guardianEmail: n(f.guardianEmail), guardianPhone: n(f.guardianPhone), summary: n(f.summary), linkedinUrl: n(f.linkedinUrl), githubUrl: n(f.githubUrl) });
      await s.reload(true); await refresh();
    }, context?.status === 'approved' ? 'Saved — identity details were sent for verification' : 'Saved');
  };

  return (
    <>
      <PageHeader title="Profile" subtitle="Your details. Changing identity fields (date of birth, gender, address, guardian) needs your instructor to verify them again." />
      <Async state={s}>{(d) => f && (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <form onSubmit={save} className="space-y-6">
            <Card title="Personal"><div className="space-y-5">
              <Photo hasPhoto={d.profile.hasPhoto} onChange={() => s.reload(true)} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full name"><Input required minLength={2} value={f.fullName} onChange={set('fullName')} /></Field>
                <Field label="Email"><Input value={d.profile.email} disabled /></Field>
                <Field label="Phone"><Input type="tel" value={f.phone} onChange={set('phone')} /></Field>
                <Field label="Date of birth"><Input type="date" max={new Date().toISOString().slice(0, 10)} value={f.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
                <Field label="Gender"><Select value={f.gender} onChange={set('gender')}><option value="">Prefer not to say</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></Select></Field>
              </div>
              <Field label="Address"><Textarea rows={2} maxLength={500} value={f.address} onChange={set('address')} /></Field>
            </div></Card>
            <Card title="Guardian"><div className="grid gap-4 sm:grid-cols-3">
              <Field label="Name"><Input value={f.guardianName} onChange={set('guardianName')} /></Field>
              <Field label="Email"><Input type="email" value={f.guardianEmail} onChange={set('guardianEmail')} /></Field>
              <Field label="Phone"><Input type="tel" value={f.guardianPhone} onChange={set('guardianPhone')} /></Field>
            </div></Card>
            <Card title="About you"><div className="space-y-4">
              <Field label="Summary" hint="Used as the starting point of your resume summary."><Textarea rows={3} maxLength={800} value={f.summary} onChange={set('summary')} /></Field>
              <div className="grid gap-4 sm:grid-cols-2"><Field label="LinkedIn"><Input type="url" placeholder="https://linkedin.com/in/…" value={f.linkedinUrl} onChange={set('linkedinUrl')} /></Field><Field label="GitHub"><Input type="url" placeholder="https://github.com/…" value={f.githubUrl} onChange={set('githubUrl')} /></Field></div>
            </div></Card>
            <div className="flex justify-end"><Button type="submit" busy={busy}>Save changes</Button></div>
          </form>

          <div className="space-y-6">
            <Card title="Verification"><div className="space-y-3 text-sm">
              <div className="flex items-center justify-between"><span className="text-muted">Profile</span><StatusChip status={d.profile.verification.status} /></div>
              {d.profile.verification.verifiedAt && <p className="text-xs text-muted">Verified on {fmtDate(d.profile.verification.verifiedAt)}</p>}
              {d.profile.verification.remarks && d.profile.verification.status !== 'verified' && <p className="rounded-xl bg-surface-2 px-3 py-2"><b>Instructor:</b> {d.profile.verification.remarks}</p>}
              {['rejected', 'correction_requested'].includes(d.profile.verification.status) && <Button size="sm" busy={busy} onClick={() => run(async () => { await api.post('/student/profile/submit'); s.reload(true); }, 'Resubmitted')}>Resubmit for verification</Button>}
            </div></Card>
            {d.academic ? (
              <Card title="My class"><dl className="space-y-2.5 text-sm">{[['Class', d.academic.className], ['Roll number', d.academic.rollNumber], ['Department', d.academic.department], ['College', d.academic.college], ['University', d.academic.university], ['Semester', d.academic.currentSemester], ['Instructor', d.academic.instructorName], ['HOD', d.academic.hodName], ['Batch', `${d.academic.admissionYear}–${d.academic.passoutYear}`]].map(([k, v]) => v && <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right font-medium">{v}</dd></div>)}</dl>
                <Button variant="danger" size="sm" className="mt-5" onClick={() => confirm('Leave this class? Your pending submissions will be withdrawn and you will need a new Class Key to rejoin.') && run(async () => { await api.post('/student/class/leave'); await refresh(); }, 'You left the class')}>Leave class</Button></Card>
            ) : <Card title="My class"><p className="text-sm text-muted">You haven't joined a class yet.</p></Card>}
          </div>
        </div>
      )}</Async>
    </>
  );
}
