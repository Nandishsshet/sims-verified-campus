import { useState } from 'react';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, PageHeader, Pill, Textarea, fmtDateTime, useAction, useLoad, useToast } from '../../ui';

/** Broadcast to the whole university: college admins, approved instructors and students of active classes. */
export default function Announcements() {
  const q = useLoad(() => api.get('/university/announcements'));
  const [run, busy] = useAction();
  const [f, setF] = useState({ title: '', body: '', pinned: false });
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const toast = useToast();

  const send = async (e) => {
    e.preventDefault(); setError(null); setSending(true);
    try {
      const r = await api.post('/university/announcements', f);
      const b = r.breakdown;
      toast(`Sent to ${r.recipients} people — ${b.collegeAdmins} admin${b.collegeAdmins === 1 ? '' : 's'}, ${b.instructors} instructor${b.instructors === 1 ? '' : 's'}, ${b.students} student${b.students === 1 ? '' : 's'}`);
      setF({ title: '', body: '', pinned: false }); q.reload(true);
    } catch (err) { setError(err); } finally { setSending(false); }
  };
  const pin = (a) => async () => { if (await run(() => api.patch(`/university/announcements/${a.id}`, { pinned: !a.pinned }))) q.reload(true); };
  const del = (a) => async () => { if (window.confirm(`Delete “${a.title}”? It disappears from students’ dashboards; notifications already sent stay.`) && await run(() => api.del(`/university/announcements/${a.id}`).then(() => true), 'Announcement deleted')) q.reload(true); };

  return (
    <>
      <PageHeader title="Announcements" subtitle="Reach every college admin, instructor and student of the university at once." />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="New announcement" className="h-fit lg:col-span-2">
          <form onSubmit={send} className="space-y-4">
            {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
            <Field label="Title" error={error?.fields?.title}><Input required minLength={2} maxLength={150} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Message" error={error?.fields?.body}><Textarea required rows={5} minLength={2} maxLength={2000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />Pin to the top of students’ dashboards</label>
            <Button type="submit" busy={sending} className="w-full">Send to the whole university</Button>
            <p className="text-xs text-muted">Everyone gets a notification: all college admins, approved instructors, and students of active classes. Students also see it on their dashboard.</p>
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
    </>
  );
}
