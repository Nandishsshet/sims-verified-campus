import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Select, Textarea, fmtDate, fmtDateTime, useAction, useLoad } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { Tabs } from './shared';

/** <input type="datetime-local"> <-> ISO string */
const toLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocal = (v) => (v ? new Date(v).toISOString() : null);

// ----------------------------------------------------------------------------- announcements
function Announcements() {
  const { url, current } = useClass();
  const [run, busy] = useAction();
  const q = useLoad(() => api.get(url('/announcements')), [current.id]);
  const [f, setF] = useState({ title: '', body: '', pinned: false });
  const post = async (e) => {
    e.preventDefault();
    if (await run(() => api.post(url('/announcements'), { ...f, title: f.title.trim(), body: f.body.trim() }), 'Announcement posted — students were notified')) { setF({ title: '', body: '', pinned: false }); q.reload(true); }
  };
  const pin = async (a) => { if (await run(() => api.patch(url(`/announcements/${a.id}`), { pinned: !a.pinned }))) q.reload(true); };
  const del = async (a) => { if (window.confirm('Delete this announcement?') && await run(() => api.del(url(`/announcements/${a.id}`)).then(() => true))) q.reload(true); };
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="New announcement">
        <form onSubmit={post} className="space-y-3">
          <Field label="Title"><Input required minLength={2} maxLength={150} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Message"><Textarea required minLength={2} maxLength={2000} rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />Pin to the top</label>
          <Button type="submit" busy={busy} className="w-full">Post to students</Button>
        </form>
      </Card>
      <div className="lg:col-span-2">
        <Async state={q}>{({ announcements }) => announcements.length === 0 ? <Empty title="No announcements yet" /> : (
          <ul className="space-y-3">{announcements.map((a) => (
            <li key={a.id} className="rounded-2xl border border-line bg-surface p-5">
              <div className="flex items-start justify-between gap-3"><h3 className="font-medium">{a.pinned && <span title="Pinned">📌 </span>}{a.title}</h3><span className="flex shrink-0 gap-3 text-xs"><button className="text-muted hover:text-ink" onClick={() => pin(a)}>{a.pinned ? 'Unpin' : 'Pin'}</button><button className="text-muted hover:text-bad" onClick={() => del(a)}>Delete</button></span></div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted">{a.body}</p>
              <p className="mt-2 text-xs text-muted">{a.author} · {fmtDateTime(a.createdAt)}</p>
            </li>
          ))}</ul>
        )}</Async>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- activities
const ACT_TYPES = ['program', 'event', 'competition', 'course', 'workshop'];
const P_STATUS = ['registered', 'attended', 'absent', 'runner_up', 'winner'];

function ActivityForm({ initial, onClose, onSaved }) {
  const { url } = useClass();
  const [f, setF] = useState(initial ? { ...initial, startsAt: toLocal(initial.startsAt), endsAt: toLocal(initial.endsAt) } : { type: 'event', title: '', description: '', venue: '', startsAt: '', endsAt: '' });
  const [error, setError] = useState(null);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    const body = { type: f.type, title: f.title.trim(), description: f.description?.trim() || null, venue: f.venue?.trim() || null, startsAt: fromLocal(f.startsAt), endsAt: fromLocal(f.endsAt) };
    try { await (initial ? api.patch(url(`/activities/${initial.id}`), body) : api.post(url('/activities'), body)); onSaved(); } catch (err) { setError(err); }
  };
  return (
    <Modal open onClose={onClose} title={initial ? 'Edit activity' : 'New activity'} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Type"><Select value={f.type} onChange={set('type')}>{ACT_TYPES.map((t) => <option key={t} value={t} className="capitalize">{t}</option>)}</Select></Field>
          <div className="sm:col-span-2"><Field label="Title" error={error?.fields?.title}><Input required minLength={2} maxLength={150} value={f.title} onChange={set('title')} /></Field></div>
          <Field label="Starts" error={error?.fields?.startsAt}><Input required type="datetime-local" value={f.startsAt} onChange={set('startsAt')} /></Field>
          <Field label="Ends (optional)" error={error?.fields?.endsAt}><Input type="datetime-local" value={f.endsAt} onChange={set('endsAt')} /></Field>
          <Field label="Venue"><Input maxLength={150} value={f.venue || ''} onChange={set('venue')} /></Field>
        </div>
        <Field label="Description"><Textarea rows={3} maxLength={2000} value={f.description || ''} onChange={set('description')} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Save</Button></div>
      </form>
    </Modal>
  );
}

function Participants({ activity, onClose }) {
  const { url } = useClass();
  const [run, busy] = useAction();
  const d = useLoad(() => api.get(url(`/activities/${activity.id}/participants`)), [activity.id]);
  const [st, setSt] = useState({});
  useEffect(() => { if (d.data) setSt(Object.fromEntries(d.data.participants.map((p) => [p.studentId, p.status]))); }, [d.data]);
  const save = async () => { if (await run(() => api.put(url(`/activities/${activity.id}/participants`), { entries: Object.entries(st).map(([studentId, status]) => ({ studentId, status })) }), 'Attendance saved')) { d.reload(true); } };
  return (
    <Modal open onClose={onClose} title={`Participants · ${activity.title}`} wide>
      <Async state={d}>{({ participants }) => participants.length === 0 ? <Empty title="Nobody has registered yet">{activity.published ? 'Students can register from their Activities page.' : 'Publish the activity so students can register.'}</Empty> : (
        <>
          <ul className="divide-y divide-line">{participants.map((p) => (
            <li key={p.studentId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="min-w-0 truncate">{p.name} <span className="text-xs text-muted">{p.rollNumber}</span></span>
              <Select aria-label={`Status for ${p.name}`} className="!w-auto" value={st[p.studentId] || 'registered'} onChange={(e) => setSt({ ...st, [p.studentId]: e.target.value })}>{P_STATUS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</Select>
            </li>
          ))}</ul>
          <div className="mt-4 flex justify-end"><Button busy={busy} onClick={save}>Save</Button></div>
        </>
      )}</Async>
    </Modal>
  );
}

function Activities() {
  const { url, current } = useClass();
  const [run] = useAction();
  const q = useLoad(() => api.get(url('/activities')), [current.id]);
  const [form, setForm] = useState(null);
  const [people, setPeople] = useState(null);
  const toggle = async (a) => { if (await run(() => api.post(url(`/activities/${a.id}/${a.published ? 'unpublish' : 'publish'}`), {}), a.published ? 'Hidden from students' : 'Published — students were notified')) q.reload(true); };
  const del = async (a) => { if (window.confirm(`Delete “${a.title}”?`) && await run(() => api.del(url(`/activities/${a.id}`)).then(() => true), 'Deleted')) q.reload(true); };
  return (
    <>
      <div className="mb-4 flex justify-end"><Button size="sm" onClick={() => setForm({})}>+ New activity</Button></div>
      <Async state={q}>{({ activities }) => activities.length === 0 ? <Empty title="No activities yet">Create events, workshops or competitions. Drafts stay hidden until you publish them.</Empty> : (
        <Card pad={false}>
          <ul className="divide-y divide-line">{activities.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1 basis-60"><div className="font-medium">{a.title} <Pill tone={a.published ? 'good' : 'muted'}>{a.published ? 'Published' : 'Draft'}</Pill></div>
                <div className="text-xs capitalize text-muted">{a.type} · {fmtDateTime(a.startsAt)}{a.venue ? ` · ${a.venue}` : ''} · {a.registered} registered · {a.attended} attended</div></div>
              <div className="flex gap-3 text-xs"><button className="font-medium text-brand" onClick={() => toggle(a)}>{a.published ? 'Unpublish' : 'Publish'}</button><button className="text-muted hover:text-ink" onClick={() => setPeople(a)}>Participants</button><button className="text-muted hover:text-ink" onClick={() => setForm(a)}>Edit</button><button className="text-muted hover:text-bad" onClick={() => del(a)}>Delete</button></div>
            </li>
          ))}</ul>
        </Card>
      )}</Async>
      {form && <ActivityForm initial={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => { setForm(null); q.reload(true); }} />}
      {people && <Participants activity={people} onClose={() => { setPeople(null); q.reload(true); }} />}
    </>
  );
}

// ----------------------------------------------------------------------------- assignments
function Submissions({ assignment, onClose }) {
  const { url } = useClass();
  const [run] = useAction();
  const d = useLoad(() => api.get(url(`/assignments/${assignment.id}/submissions`)), [assignment.id]);
  const [remarks, setRemarks] = useState({});
  const save = async (s) => { const t = (remarks[s.studentId] ?? s.remarks ?? '').trim(); if (t && await run(() => api.put(url(`/assignments/${assignment.id}/submissions/${s.studentId}`), { remarks: t }), 'Remark saved')) d.reload(true); };
  return (
    <Modal open onClose={onClose} title={`Submissions · ${assignment.title}`} wide>
      <Async state={d}>{({ submissions }) => submissions.length === 0 ? <Empty title="No students in the class yet" /> : (
        <ul className="divide-y divide-line">{submissions.map((s) => (
          <li key={s.studentId} className="space-y-2 py-3 text-sm">
            <div className="flex items-center justify-between gap-3"><span>{s.name} <span className="text-xs text-muted">{s.rollNumber}</span></span>
              {s.submittedAt ? <Pill tone={s.late ? 'warn' : 'good'}>{s.late ? 'Late · ' : 'On time · '}{fmtDate(s.submittedAt)}</Pill> : <Pill tone="bad">Not submitted</Pill>}</div>
            <div className="flex gap-2"><Input aria-label={`Remark for ${s.name}`} placeholder="Remark (optional)" maxLength={500} value={remarks[s.studentId] ?? s.remarks ?? ''} onChange={(e) => setRemarks({ ...remarks, [s.studentId]: e.target.value })} /><Button size="sm" variant="secondary" onClick={() => save(s)}>Save</Button></div>
          </li>
        ))}</ul>
      )}</Async>
    </Modal>
  );
}

function Assignments() {
  const { url, current } = useClass();
  const [run, busy] = useAction();
  const q = useLoad(() => api.get(url('/assignments')), [current.id]);
  const subjects = useLoad(() => api.get(url('/subjects')), [current.id]);
  const [f, setF] = useState({ title: '', description: '', dueAt: '', subjectId: '' });
  const [open, setOpen] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post(url('/assignments'), { title: f.title.trim(), description: f.description.trim() || null, dueAt: fromLocal(f.dueAt), subjectId: f.subjectId || null }), 'Assignment created');
    if (r) { setF({ title: '', description: '', dueAt: '', subjectId: '' }); q.reload(true); }
  };
  const del = async (a) => { if (window.confirm(`Delete “${a.title}”?`) && await run(() => api.del(url(`/assignments/${a.id}`)).then(() => true), 'Deleted')) q.reload(true); };
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="New assignment">
        <form onSubmit={create} className="space-y-3">
          <Field label="Title"><Input required minLength={2} maxLength={150} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Subject (optional)"><Select value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })}><option value="">—</option>{subjects.data?.subjects.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
          <Field label="Due"><Input required type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
          <Field label="Details"><Textarea rows={3} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Button type="submit" busy={busy} className="w-full">Create</Button>
        </form>
      </Card>
      <div className="lg:col-span-2">
        <Async state={q}>{({ assignments }) => assignments.length === 0 ? <Empty title="No assignments yet" /> : (
          <Card pad={false}><ul className="divide-y divide-line">{assignments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1 basis-56"><div className="font-medium">{a.title}</div><div className="text-xs text-muted">{a.subject ? `${a.subject} · ` : ''}Due {fmtDateTime(a.dueAt)}{new Date(a.dueAt) < new Date() ? ' (closed)' : ''}</div></div>
              <Pill tone={a.submitted === a.total && a.total > 0 ? 'good' : 'muted'}>{a.submitted}/{a.total} submitted</Pill>
              <div className="flex gap-3 text-xs"><button className="font-medium text-brand" onClick={() => setOpen(a)}>Submissions</button><button className="text-muted hover:text-bad" onClick={() => del(a)}>Delete</button></div>
            </li>
          ))}</ul></Card>
        )}</Async>
      </div>
      {open && <Submissions assignment={open} onClose={() => { setOpen(null); q.reload(true); }} />}
    </div>
  );
}

// ----------------------------------------------------------------------------- parent notices
const REASON = { low_attendance: 'Low attendance', poor_marks: 'Poor marks', custom: 'Other' };

function ParentNotices() {
  const { url, current } = useClass();
  const [run, busy] = useAction();
  const students = useLoad(() => api.get(url('/students')), [current.id]);
  const log = useLoad(() => api.get(url('/parent-notifications')), [current.id]);
  const [picked, setPicked] = useState(new Set());
  const [f, setF] = useState({ channel: 'email', reason: 'low_attendance', message: '' });
  const [result, setResult] = useState(null);
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const lowAtt = (students.data?.students || []).filter((s) => s.attendancePct != null && s.attendancePct < 75).map((s) => s.id);

  const send = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post(url('/parent-notifications'), { studentIds: [...picked], ...f, message: f.message.trim() }));
    if (r) { setResult(r); setPicked(new Set()); setF({ ...f, message: '' }); log.reload(true); }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Message guardians">
        <form onSubmit={send} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Channel"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="email">E-mail</option><option value="sms">SMS</option></Select></Field>
            <Field label="Reason"><Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{Object.entries(REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          </div>
          <Field label="Message"><Textarea required minLength={5} maxLength={600} rows={4} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-sm"><span className="font-medium">Students ({picked.size})</span>
              <span className="flex gap-3 text-xs">{lowAtt.length > 0 && <button type="button" className="text-brand" onClick={() => setPicked(new Set(lowAtt))}>Select below 75% ({lowAtt.length})</button>}<button type="button" className="text-muted" onClick={() => setPicked(new Set())}>Clear</button></span></div>
            <Async state={students}>{({ students: list }) => (
              <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line">{list.map((s) => (
                <li key={s.id}><label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2"><input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} /><span className="flex-1 truncate">{s.name}</span>{s.attendancePct != null && <span className="text-xs text-muted">{Math.round(s.attendancePct)}%</span>}</label></li>
              ))}</ul>
            )}</Async>
          </div>
          <Button type="submit" busy={busy} disabled={picked.size === 0}>Queue messages</Button>
          {result && (
            <div role="status" className="rounded-xl bg-surface-2 p-3 text-sm">
              <b>{result.queued}</b> queued{result.failed > 0 && <>, <b className="text-bad">{result.failed}</b> could not be sent</>}.
              {result.results.filter((r) => r.problem).map((r) => <p key={r.studentId} className="mt-1 text-xs text-bad">{r.name}: {r.problem}</p>)}
            </div>
          )}
        </form>
      </Card>
      <Card title="Recent messages" pad={false}>
        <Async state={log}>{({ notifications }) => notifications.length === 0 ? <p className="p-5 text-sm text-muted">Nothing sent yet.</p> : (
          <ul className="divide-y divide-line">{notifications.slice(0, 20).map((n) => (
            <li key={n.id} className="px-5 py-3 text-sm"><div className="flex items-center justify-between gap-2"><span className="font-medium">{n.student}</span><Pill tone={n.status === 'failed' ? 'bad' : 'good'}>{n.status}</Pill></div>
              <div className="text-xs text-muted">{n.channel} · {REASON[n.reason] || n.reason} · {fmtDateTime(n.createdAt)}</div><p className="mt-1 line-clamp-2 text-xs text-muted">{n.message}</p></li>
          ))}</ul>
        )}</Async>
      </Card>
    </div>
  );
}

export default function Life() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'announcements';
  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Class life" subtitle="Announcements, activities, assignments and guardian messages." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'announcements', label: 'Announcements' }, { id: 'activities', label: 'Activities' }, { id: 'assignments', label: 'Assignments' }, { id: 'parents', label: 'Guardian messages' }]} />
      {tab === 'activities' ? <Activities /> : tab === 'assignments' ? <Assignments /> : tab === 'parents' ? <ParentNotices /> : <Announcements />}
    </>
  );
}
