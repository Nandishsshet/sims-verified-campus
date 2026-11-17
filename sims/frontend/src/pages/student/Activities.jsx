import { api } from '../../api';
import { Async, Button, Card, Empty, PageHeader, Pill, fmtDate, fmtDateTime, useAction, useLoad } from '../../ui';

const TONE = { competition: 'bad', workshop: 'info', event: 'brand', program: 'good', course: 'warn' };
const STATUS = { registered: ['Registered', 'info'], attended: ['Attended', 'good'], absent: ['Absent', 'bad'], winner: ['Winner 🏆', 'good'], runner_up: ['Runner-up', 'good'] };

export default function Activities() {
  const acts = useLoad(() => api.get('/student/activities'));
  const ann = useLoad(() => api.get('/student/announcements'));
  const [run] = useAction();
  return (
    <>
      <PageHeader title="Activities & announcements" subtitle="Events, workshops and notices from your class, college and university." />
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <div>
          <h2 className="mb-3 text-sm font-semibold">Activities</h2>
          <Async state={acts}>{(d) => d.activities.length === 0 ? <Empty title="No activities yet">Your instructor publishes programs and events here.</Empty> : (
            <div className="space-y-3">{d.activities.map((a) => (
              <Card key={a.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{a.title}</h3><Pill tone={TONE[a.type]}>{a.type}</Pill></div>
                    <p className="mt-1 text-sm text-muted">{fmtDateTime(a.startsAt)}{a.venue ? ` · ${a.venue}` : ''}</p></div>
                  {a.myStatus ? <Pill tone={STATUS[a.myStatus][1]}>{STATUS[a.myStatus][0]}</Pill> : a.open ? <Button size="sm" onClick={() => run(async () => { await api.post(`/student/activities/${a.id}/register`); acts.reload(true); }, 'Registered')}>Register</Button> : <Pill>Ended</Pill>}
                </div>
                {a.description && <p className="mt-2 text-sm text-muted">{a.description}</p>}
              </Card>
            ))}</div>
          )}</Async>
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold">Announcements</h2>
          <Async state={ann}>{(d) => d.announcements.length === 0 ? <Empty title="No announcements" /> : (
            <div className="space-y-3">{d.announcements.map((a) => (
              <Card key={a.id}>
                <div className="flex items-center gap-2">{a.pinned && <Pill tone="warn">📌 Pinned</Pill>}<Pill>{a.scope}</Pill></div>
                <h3 className="mt-2 font-semibold leading-snug">{a.title}</h3><p className="mt-1 text-sm text-muted">{a.body}</p>
                <p className="mt-2 text-xs text-muted">{a.author} · {fmtDate(a.createdAt)}</p>
              </Card>
            ))}</div>
          )}</Async>
        </div>
      </div>
    </>
  );
}
