import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Field, Input, Modal, PageHeader, Pill, Progress, Select, StatusChip, Stat, Textarea, fmtDate, fmtDateTime, num, useAction, useLoad } from '../../ui';
import { useClass } from './ClassContext';
import { RiskPill, TYPE_LABEL, pctTone } from './shared';

const COMPONENT_LABEL = { marks: 'Marks', attendance: 'Attendance', certificates: 'Certificates', skills: 'Skills', resume: 'Resume', activity: 'Activities' };

/** Queue a parent / guardian message for this one student. */
function ParentNotice({ student, onClose, onDone }) {
  const { url } = useClass();
  const [run, busy] = useAction();
  const [f, setF] = useState({ channel: 'email', reason: 'custom', message: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const send = async () => {
    if (f.message.trim().length < 5) { setError('Write at least a few words.'); return; }
    const r = await run(() => api.post(url('/parent-notifications'), { studentIds: [student.id], ...f, message: f.message.trim() }));
    if (!r) return;
    if (r.failed) setError(r.results[0]?.problem || 'Could not be queued');
    else onDone('Message queued for the guardian');
  };
  return (
    <Modal open onClose={onClose} title={`Message ${student.name}’s guardian`}>
      <div className="space-y-4">
        {!student.guardian.name && !student.guardian.email && !student.guardian.phone && <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn">The student has not added guardian details yet, so this may not be deliverable.</p>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Channel"><Select value={f.channel} onChange={set('channel')}><option value="email">E-mail</option><option value="sms">SMS</option></Select></Field>
          <Field label="Reason"><Select value={f.reason} onChange={set('reason')}><option value="low_attendance">Low attendance</option><option value="poor_marks">Poor marks</option><option value="custom">Other</option></Select></Field>
        </div>
        <Field label="Message" error={error}><Textarea rows={4} maxLength={600} value={f.message} onChange={set('message')} /></Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={send}>Queue message</Button></div>
      </div>
    </Modal>
  );
}

export default function StudentDetail() {
  const { sid } = useParams();
  const { url, current } = useClass();
  const d = useLoad(() => api.get(url(`/students/${sid}`)), [current.id, sid]);
  const [run, busy] = useAction();
  const [note, setNote] = useState({ text: '', visible: false });
  const [roll, setRoll] = useState(null);
  const [notice, setNotice] = useState(false);

  const addNote = async () => {
    if (note.text.trim().length < 2) return;
    const r = await run(() => api.post(url(`/students/${sid}/notes`), { note: note.text.trim(), visibleToStudent: note.visible }), 'Note saved');
    if (r) { setNote({ text: '', visible: false }); d.reload(true); }
  };
  const delNote = async (id) => { if (await run(() => api.del(url(`/students/${sid}/notes/${id}`)).then(() => true), 'Note deleted')) d.reload(true); };
  const saveRoll = async () => { if (await run(() => api.patch(url(`/students/${sid}`), { rollNumber: roll.trim() }).then(() => true), 'Roll number updated')) { setRoll(null); d.reload(true); } };

  return (
    <Async state={d}>{(x) => {
      const s = x.student;
      return (
        <>
          <Link to="/class/students" className="mb-3 inline-block text-sm text-muted hover:text-ink">← All students</Link>
          <PageHeader title={s.name} subtitle={`${s.rollNumber || 'No roll number'} · ${s.email}${s.phone ? ` · ${s.phone}` : ''}`}
            action={<div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => setRoll(s.rollNumber || '')}>Edit roll number</Button><Button variant="secondary" size="sm" onClick={() => setNotice(true)}>Message guardian</Button></div>} />

          {x.pending.length > 0 && (
            <Link to="/class/verification" className="mb-5 block rounded-xl bg-warn-soft px-4 py-2.5 text-sm text-warn">{x.pending.length} item{x.pending.length === 1 ? '' : 's'} from this student {x.pending.length === 1 ? 'is' : 'are'} waiting for verification: {[...new Set(x.pending.map((p) => TYPE_LABEL[p.type] || p.type))].join(', ')}.</Link>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Class rank" value={x.rank.rank ? `#${x.rank.rank}` : '—'} hint={`of ${x.rank.of} · score ${num(x.rank.score)}`} tone="brand" />
            <Stat label="CGPA" value={num(x.academics.cgpa, 2)} hint={`${x.academics.activeBacklogs.length} active backlog${x.academics.activeBacklogs.length === 1 ? '' : 's'}`} />
            <Stat label="Attendance" value={x.attendance.overall.held ? `${num(x.attendance.overall.percentage)}%` : '—'} tone={x.attendance.overall.held ? (x.attendance.overall.percentage >= 75 ? 'good' : 'bad') : 'default'} hint={x.attendance.overall.held ? `${x.attendance.overall.attended}/${x.attendance.overall.held} classes` : 'No verified attendance'} />
            <Stat label="Placement readiness" value={x.placementReadiness != null ? `${num(x.placementReadiness, 0)}%` : '—'} hint={x.resumeScore != null ? `Resume score ${num(x.resumeScore, 0)}` : 'No resume yet'} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title="Dropout risk" action={<RiskPill band={x.risk.band} />}>
              {x.risk.reasons.length === 0 ? <p className="text-sm text-muted">{x.risk.band === 'unknown' ? 'There is not enough verified data to assess risk yet.' : 'No warning signs in the verified data.'}</p>
                : <ul className="space-y-2 text-sm">{x.risk.reasons.map((r) => <li key={r} className="flex gap-2"><span className="text-warn">●</span>{r}</li>)}</ul>}
            </Card>
            <Card title="Score breakdown" className="lg:col-span-2">
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.keys(COMPONENT_LABEL).map((k) => (
                  <div key={k}>
                    <div className="mb-1 flex justify-between text-xs"><span>{COMPONENT_LABEL[k]} <span className="text-muted">· weight {x.rank.weights[k]}%</span></span><span className="tabular-nums">{num(x.rank.components[k], 0)}</span></div>
                    <Progress value={x.rank.components[k]} tone="brand" label={COMPONENT_LABEL[k]} />
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card title="Attendance by subject" pad={false}>
              {x.attendance.subjects.length === 0 ? <p className="p-5 text-sm text-muted">No verified attendance yet.</p> : (
                <ul className="divide-y divide-line">{x.attendance.subjects.map((a) => (
                  <li key={a.subjectId || a.code} className="flex items-center justify-between gap-3 px-5 py-3 text-sm"><span className="min-w-0 truncate">{a.code} · {a.name}</span><span className={`tabular-nums font-medium ${pctTone(a.percentage)}`}>{num(a.percentage)}% <span className="text-xs font-normal text-muted">({a.attended}/{a.held})</span></span></li>
                ))}</ul>
              )}
            </Card>
            <Card title="Semester results" pad={false}>
              {x.academics.semesters.length === 0 ? <p className="p-5 text-sm text-muted">No verified marks yet.</p> : (
                <ul className="divide-y divide-line">{x.academics.semesters.map((sm) => (
                  <li key={sm.semester} className="flex items-center justify-between px-5 py-3 text-sm"><span>Semester {sm.semester} <span className="text-muted">· {sm.subjects.length} subjects</span></span><span className="flex items-center gap-2">{sm.backlogs > 0 && <Pill tone="bad">{sm.backlogs} backlog{sm.backlogs === 1 ? '' : 's'}</Pill>}<b className="tabular-nums">SGPA {num(sm.sgpa, 2)}</b></span></li>
                ))}</ul>
              )}
            </Card>
            <Card title="Certificates" pad={false}>
              {x.certificates.length === 0 ? <p className="p-5 text-sm text-muted">None uploaded.</p> : (
                <ul className="divide-y divide-line">{x.certificates.map((c) => <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm"><span className="min-w-0 truncate">{c.title} <span className="text-muted">· {c.issuer}</span></span><StatusChip status={c.status} /></li>)}</ul>
              )}
            </Card>
            <Card title="Projects & experience" pad={false}>
              {x.portfolio.length === 0 ? <p className="p-5 text-sm text-muted">None added.</p> : (
                <ul className="divide-y divide-line">{x.portfolio.map((c) => <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm"><span className="min-w-0 truncate">{c.title} <span className="text-muted">· {c.type}</span></span><StatusChip status={c.status} /></li>)}</ul>
              )}
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title="Mentoring notes" className="lg:col-span-2">
              <div className="space-y-3">
                <Textarea rows={2} maxLength={2000} placeholder="Write a private note about this student…" value={note.text} onChange={(e) => setNote((p) => ({ ...p, text: e.target.value }))} aria-label="New note" />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={note.visible} onChange={(e) => setNote((p) => ({ ...p, visible: e.target.checked }))} />Mark as shareable with the student</label>
                  <Button size="sm" busy={busy} onClick={addNote} disabled={note.text.trim().length < 2}>Add note</Button>
                </div>
              </div>
              {x.notes.length > 0 && (
                <ul className="mt-5 divide-y divide-line border-t border-line">{x.notes.map((n) => (
                  <li key={n.id} className="flex items-start justify-between gap-3 py-3 text-sm">
                    <div><p className="whitespace-pre-wrap">{n.note}</p><p className="mt-1 text-xs text-muted">{n.by} · {fmtDateTime(n.createdAt)}{n.visibleToStudent ? ' · shareable' : ''}</p></div>
                    <button onClick={() => delNote(n.id)} className="shrink-0 text-xs text-muted hover:text-bad">Delete</button>
                  </li>
                ))}</ul>
              )}
            </Card>
            <Card title="Guardian">
              <dl className="space-y-2 text-sm">
                {[['Name', s.guardian.name], ['E-mail', s.guardian.email], ['Phone', s.guardian.phone]].map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd>{v || '—'}</dd></div>)}
              </dl>
              {x.parentNotifications.length > 0 && (
                <div className="mt-4 border-t border-line pt-3"><div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Recent messages</div>
                  <ul className="space-y-1 text-xs text-muted">{x.parentNotifications.map((p, i) => <li key={i}>{fmtDate(p.createdAt)} · {p.channel} · {p.reason.replace('_', ' ')} · {p.status}</li>)}</ul></div>
              )}
            </Card>
          </div>

          <Modal open={roll !== null} onClose={() => setRoll(null)} title="Roll number">
            <div className="space-y-4">
              <Field label="Roll number" hint="Must be unique within the class."><Input value={roll ?? ''} maxLength={40} onChange={(e) => setRoll(e.target.value)} /></Field>
              <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRoll(null)}>Cancel</Button><Button busy={busy} disabled={!roll?.trim()} onClick={saveRoll}>Save</Button></div>
            </div>
          </Modal>
          {notice && <ParentNotice student={{ id: sid, name: s.name, guardian: s.guardian }} onClose={() => setNotice(false)} onDone={() => { setNotice(false); d.reload(true); }} />}
        </>
      );
    }}</Async>
  );
}
