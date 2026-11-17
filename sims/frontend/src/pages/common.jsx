import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Async, Button, Card, Empty, Field, Input, PageHeader, Pill, useAction, useLoad, fmtDateTime } from '../ui';

/** Shown instead of the student area until the instructor approves the student's Class Key request. */
export function JoinGate() {
  const { context, refresh, user } = useAuth();
  const [run, busy] = useAction();
  const [key, setKey] = useState('');
  const [roll, setRoll] = useState('');
  const [error, setError] = useState(null);
  const nav = useNavigate();

  const join = async (e) => {
    e.preventDefault(); setError(null);
    try { await api.post('/join/class', { classKey: key.trim(), ...(roll.trim() ? { rollNumber: roll.trim() } : {}) }); await refresh(); }
    catch (err) { setError(err); }
  };

  if (context?.status === 'pending') {
    return (
      <div className="mx-auto max-w-xl pt-6">
        <Card>
          <div className="flex size-12 items-center justify-center rounded-2xl bg-warn-soft text-warn"><Icon name="shield" className="size-6" /></div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Waiting for your instructor</h1>
          <p className="mt-2 text-sm text-muted">
            Your request to join <b className="text-ink">{context.class?.name}</b>{context.college ? <> at {context.college}</> : null} has been sent. You'll get a notification as soon as it is approved.
            Meanwhile you can complete your profile — it will be queued for verification automatically once you're in.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => nav('/student/profile')}>Complete my profile</Button>
            <Button variant="secondary" onClick={() => run(refresh)}>Check status</Button>
            <Button variant="ghost" busy={busy} onClick={() => run(async () => { await api.post('/student/class/leave'); await refresh(); }, 'Request withdrawn')}>Withdraw request</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl pt-6">
      <Card>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand"><Icon name="school" className="size-6" /></div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Welcome, {user.fullName.split(' ')[0]} 👋</h1>
        <p className="mt-2 text-sm text-muted">Enter the Class Key your instructor shared to join your class. Your instructor approves each request before your data becomes part of the class.</p>
        <form onSubmit={join} className="mt-5 space-y-4">
          {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
          <Field label="Class Key"><Input required placeholder="CLS-XXXX-XXXX" className="font-mono uppercase" value={key} onChange={(e) => setKey(e.target.value)} autoFocus /></Field>
          <Field label="Roll number (optional)"><Input value={roll} onChange={(e) => setRoll(e.target.value)} /></Field>
          <Button type="submit" className="w-full">Request to join</Button>
        </form>
      </Card>
    </div>
  );
}

/** Placeholder for dashboards delivered in later phases — still shows the account context. */
export function ComingSoon({ title, phase, bullets = [] }) {
  const { user, context } = useAuth();
  return (
    <>
      <PageHeader title={title} subtitle={`Signed in as ${user.fullName}`} />
      <Card>
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand"><Icon name="spark" /></div>
          <div>
            <h2 className="font-semibold">Arriving in {phase}</h2>
            <p className="mt-1 text-sm text-muted">Your account, key onboarding and approvals already work. This dashboard is built in a later phase:</p>
            <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted">{bullets.map((b) => <li key={b}>{b}</li>)}</ul>
            {context?.status && <div className="mt-4"><Pill tone={context.status === 'approved' || context.status === 'active' ? 'good' : 'warn'}>Membership: {context.status}</Pill></div>}
          </div>
        </div>
      </Card>
    </>
  );
}

export function NotificationsPage() {
  const s = useLoad(() => api.get('/notifications?limit=100'));
  const nav = useNavigate();
  const [run] = useAction();
  return (
    <>
      <PageHeader title="Notifications" action={<Button variant="secondary" onClick={() => run(async () => { await api.post('/notifications/read-all'); await s.reload(true); })}>Mark all read</Button>} />
      <Async state={s}>{(d) => d.notifications.length === 0 ? <Empty title="Nothing here yet">Approvals, verification results and reminders will appear here.</Empty> : (
        <Card pad={false}>
          <ul className="divide-y divide-line">
            {d.notifications.map((n) => (
              <li key={n.id}>
                <button className={`flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-surface-2 ${n.read ? '' : 'bg-brand-soft/40'}`}
                  onClick={async () => { if (!n.read) await api.post(`/notifications/${n.id}/read`); if (n.link) nav(n.link); else s.reload(true); }}>
                  {!n.read ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" /> : <span className="size-2 shrink-0" />}
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{n.title}</span>{n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}</span>
                  <span className="shrink-0 text-xs text-muted">{fmtDateTime(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}</Async>
    </>
  );
}
