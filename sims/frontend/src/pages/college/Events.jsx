import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Select, Textarea, fmtDateTime, useAction, useLoad, useToast } from '../../ui';
import { Tabs } from '../class/shared';

const TYPES = [['event', 'Event'], ['workshop', 'Workshop'], ['competition', 'Competition'], ['program', 'Program'], ['course', 'Course']];
const TYPE_LABEL = Object.fromEntries(TYPES);

/** <input type="datetime-local"> value → ISO string for the API (local time → UTC). */
const toISO = (v) => (v ? new Date(v).toISOString() : undefined);

/** Create one published activity in every active class (of a department, or the whole college). */
function EventModal({ onClose, onCreated }) {
  const depts = useLoad(() => api.get('/college/departments'));
  const toast = useToast();
  const [f, setF] = useState({ type: 'event', title: '', description: '', venue: '', startsAt: '', endsAt: '', departmentId: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const body = { type: f.type, title: f.title, startsAt: toISO(f.startsAt), ...(f.endsAt && { endsAt: toISO(f.endsAt) }), ...(f.description.trim() && { description: f.description }), ...(f.venue.trim() && { venue: f.venue }), ...(f.departmentId && { departmentId: f.departmentId }) };
      const r = await api.post('/college/events', body);
      toast(`Published in ${r.created} class${r.created === 1 ? '' : 'es'} · ${r.notified} student${r.notified === 1 ? '' : 's'} notified`);
      onCreated();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Create an event" wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.code === 'NO_CLASSES' ? 'There is no active class to publish this in yet.' : error.message}</div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" error={error?.fields?.title}><Input required minLength={2} maxLength={150} value={f.title} onChange={set('title')} autoFocus /></Field>
          <Field label="Type"><Select value={f.type} onChange={set('type')}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Starts" error={error?.fields?.startsAt}><Input required type="datetime-local" value={f.startsAt} onChange={set('startsAt')} /></Field>
          <Field label="Ends (optional)" error={error?.fields?.endsAt}><Input type="datetime-local" min={f.startsAt || undefined} value={f.endsAt} onChange={set('endsAt')} /></Field>
          <Field label="Venue (optional)"><Input maxLength={150} value={f.venue} onChange={set('venue')} /></Field>
          <Field label="For" hint="Published in each active class of this scope."><Select value={f.departmentId} onChange={set('departmentId')}><option value="">The whole college</option>{depts.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name} only</option>)}</Select></Field>
        </div>
        <Field label="Description (optional)"><Textarea maxLength={2000} value={f.description} onChange={set('description')} /></Field>
        <p className="text-xs text-muted">Each class gets its own copy. Instructors mark who attended on their Class life page, and attendance feeds the “event participation” score.</p>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Publish event</Button></div>
      </form>
    </Modal>
  );
}

/** One row per (event × class) is noisy, so group copies of the same event together. */
function groupEvents(events) {
  const m = new Map();
  for (const e of events) {
    const key = `${e.title}|${e.startsAt}|${e.type}`;
    const g = m.get(key) || { ...e, classes: [], registered: 0, attended: 0 };
    g.classes.push(e.class.name); g.registered += e.registered; g.attended += e.attended;
    m.set(key, g);
  }
  return [...m.values()];
}

function EventsTab() {
  const [dept, setDept] = useState('');
  const [when, setWhen] = useState('upcoming');
  const [open, setOpen] = useState(false);
  const depts = useLoad(() => api.get('/college/departments'));
  const q = useLoad(() => api.get(`/college/events${dept ? `?departmentId=${dept}` : ''}`), [dept]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Department" className="!w-auto" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{depts.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select aria-label="When" className="!w-auto" value={when} onChange={(e) => setWhen(e.target.value)}><option value="upcoming">Upcoming</option><option value="past">Past</option><option value="all">All</option></Select>
        <Button className="ml-auto" onClick={() => setOpen(true)}>Create event</Button>
      </div>
      <Async state={q}>{({ events }) => {
        const now = Date.now();
        const shown = groupEvents(events).filter((e) => (when === 'all' ? true : when === 'upcoming' ? new Date(e.endsAt || e.startsAt) >= now : new Date(e.endsAt || e.startsAt) < now))
          .sort((a, b) => (when === 'past' ? new Date(b.startsAt) - new Date(a.startsAt) : new Date(a.startsAt) - new Date(b.startsAt)));
        return shown.length === 0 ? <Empty title={`No ${when === 'all' ? '' : `${when} `}events`} action={<Button onClick={() => setOpen(true)}>Create event</Button>}>Events you publish show up on every student’s Activities page.</Empty> : (
          <Card pad={false}>
            <ul className="divide-y divide-line">
              {shown.map((e) => (
                <li key={`${e.title}${e.startsAt}`} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{e.title} <Pill tone="brand">{TYPE_LABEL[e.type] || e.type}</Pill></div>
                    <div className="mt-0.5 text-xs text-muted">{fmtDateTime(e.startsAt)}{e.venue ? ` · ${e.venue}` : ''}</div>
                    <div className="mt-1 text-xs text-muted">{e.classes.length === 1 ? e.classes[0] : `${e.classes.length} classes`}{e.classes.length > 1 && <span className="hidden sm:inline"> — {e.classes.slice(0, 3).join(', ')}{e.classes.length > 3 ? ', …' : ''}</span>}</div>
                  </div>
                  <div className="text-right text-xs text-muted"><div><b className="text-sm tabular-nums text-ink">{e.attended}</b> attended</div><div>{e.registered} registered</div></div>
                </li>
              ))}
            </ul>
          </Card>
        );
      }}</Async>
      {open && <EventModal onClose={() => setOpen(false)} onCreated={() => { setOpen(false); q.reload(true); }} />}
    </>
  );
}

function AnnouncementsTab() {
  const q = useLoad(() => api.get('/college/announcements'));
  const [run, busy] = useAction();
  const [f, setF] = useState({ title: '', body: '', pinned: false });
  const [error, setError] = useState(null);
  const toast = useToast();
  const [sending, setSending] = useState(false);

  const send = async (e) => {
    e.preventDefault(); setError(null); setSending(true);
    try {
      const r = await api.post('/college/announcements', f);
      toast(`Sent to ${r.recipients} student${r.recipients === 1 ? '' : 's'} and instructors`);
      setF({ title: '', body: '', pinned: false }); q.reload(true);
    } catch (err) { setError(err); } finally { setSending(false); }
  };
  const pin = (a) => async () => { if (await run(() => api.patch(`/college/announcements/${a.id}`, { pinned: !a.pinned }))) q.reload(true); };
  const del = (a) => async () => { if (window.confirm(`Delete “${a.title}”? It disappears from students’ dashboards; notifications already sent stay.`) && await run(() => api.del(`/college/announcements/${a.id}`).then(() => true), 'Announcement deleted')) q.reload(true); };

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card title="New announcement" className="h-fit lg:col-span-2">
        <form onSubmit={send} className="space-y-4">
          {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
          <Field label="Title" error={error?.fields?.title}><Input required minLength={2} maxLength={150} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Message" error={error?.fields?.body}><Textarea required rows={5} minLength={2} maxLength={2000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />Pin to the top of students’ dashboards</label>
          <Button type="submit" busy={sending} className="w-full">Send to the whole college</Button>
          <p className="text-xs text-muted">Every student and approved instructor in your college gets a notification.</p>
        </form>
      </Card>
      <div className="lg:col-span-3">
        <Async state={q}>{({ announcements }) => announcements.length === 0 ? <Empty title="No announcements yet">Announcements you send appear here and on every student’s dashboard.</Empty> : (
          <Card pad={false}>
            <ul className="divide-y divide-line">
              {announcements.map((a) => (
                <li key={a.id} className="px-5 py-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="font-medium">{a.title} {a.pinned && <Pill tone="brand">Pinned</Pill>}</div>
                    <div className="flex gap-1.5"><Button size="sm" variant="ghost" busy={busy} onClick={pin(a)}>{a.pinned ? 'Unpin' : 'Pin'}</Button><Button size="sm" variant="ghost" busy={busy} onClick={del(a)}>Delete</Button></div>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-muted">{a.body}</p>
                  <div className="mt-1.5 text-xs text-muted">{a.author} · {fmtDateTime(a.createdAt)}</div>
                </li>
              ))}
            </ul>
          </Card>
        )}</Async>
      </div>
    </div>
  );
}

export default function Events() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'events';
  return (
    <>
      <PageHeader title="Events & announcements" subtitle="Publish to every class at once; instructors then run attendance for their own class." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'events', label: 'Events' }, { id: 'announcements', label: 'Announcements' }]} />
      {tab === 'announcements' ? <AnnouncementsTab /> : <EventsTab />}
    </>
  );
}
