import { useState } from 'react';
import { api } from '../../api';
import { Icon } from '../../icons';
import { Async, Button, Card, Empty, Field, Input, PageHeader, Pill, Progress, Select, fmtDate, fmtDateTime, num, useAction, useLoad } from '../../ui';

const GOAL_TYPES = { cgpa: 'CGPA', attendance: 'Attendance %', certificate: 'Certificates', skill: 'Skill readiness %', custom: 'Custom' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const today = () => new Date().toISOString().slice(0, 10);

function Goals() {
  const s = useLoad(() => api.get('/student/goals'));
  const [run, busy] = useAction();
  const [f, setF] = useState({ type: 'cgpa', title: '', targetValue: '', deadline: '' });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const add = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.post('/student/goals', { type: f.type, title: f.title, ...(f.targetValue !== '' ? { targetValue: Number(f.targetValue) } : {}), ...(f.deadline ? { deadline: f.deadline } : {}) }), 'Goal added');
    if (ok) { setF({ type: 'cgpa', title: '', targetValue: '', deadline: '' }); s.reload(true); }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Async state={s}>{(d) => d.goals.length === 0 ? <Empty title="No goals yet">Set a target — CGPA, attendance, certificates — and track it automatically from your verified data.</Empty> : (
        <ul className="space-y-3">{d.goals.map((g) => (
          <Card key={g.id}>
            <div className="flex items-start justify-between gap-3">
              <div><p className="font-medium">{g.title}</p><p className="text-xs text-muted">{GOAL_TYPES[g.type]}{g.deadline ? ` · by ${fmtDate(g.deadline)}` : ''}</p></div>
              <div className="flex items-center gap-2">{g.isDone && <Pill tone="good">Done</Pill>}
                <button onClick={() => run(async () => { await api.del(`/student/goals/${g.id}`); s.reload(true); })} className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-bad" aria-label={`Delete goal ${g.title}`}><Icon name="trash" className="size-4" /></button></div>
            </div>
            {g.targetValue != null && <div className="mt-3"><div className="mb-1 flex justify-between text-xs"><span>{g.currentValue != null ? num(g.currentValue, 2) : '—'} now</span><span>target {g.targetValue}</span></div><Progress value={g.progressPct ?? 0} tone="brand" label={g.title} /></div>}
            {g.type === 'custom' && !g.isDone && <Button size="sm" variant="secondary" className="mt-3" onClick={() => run(async () => { await api.patch(`/student/goals/${g.id}`, { isDone: true }); s.reload(true); })}>Mark done</Button>}
          </Card>
        ))}</ul>
      )}</Async>
      <Card title="New goal">
        <form onSubmit={add} className="space-y-3">
          <Field label="Type"><Select value={f.type} onChange={set('type')}>{Object.entries(GOAL_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Title"><Input required minLength={2} value={f.title} onChange={set('title')} placeholder="Reach 8.5 CGPA" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Target"><Input type="number" step="any" min={0} value={f.targetValue} onChange={set('targetValue')} /></Field><Field label="Deadline"><Input type="date" value={f.deadline} onChange={set('deadline')} /></Field></div>
          <p className="text-xs text-muted">CGPA, attendance, certificate and skill goals update themselves from verified data.</p>
          <Button type="submit" busy={busy} className="w-full">Add goal</Button>
        </form>
      </Card>
    </div>
  );
}

function StudyPlan() {
  const s = useLoad(() => api.get('/student/study-plan'));
  const [run, busy] = useAction();
  const [f, setF] = useState({ title: '', plannedDate: today(), durationMin: 60 });
  const add = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.post('/student/study-plan', { title: f.title, plannedDate: f.plannedDate, durationMin: Number(f.durationMin) }), 'Added to your plan');
    if (ok) { setF((p) => ({ ...p, title: '' })); s.reload(true); }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Async state={s}>{(d) => {
        const days = [...new Set(d.items.map((i) => i.plannedDate))];
        return d.items.length === 0 ? <Empty title="Nothing planned">Break your goals into study sessions.</Empty> : (
          <div className="space-y-4">{days.map((day) => (
            <Card key={day} title={day === today() ? `Today · ${fmtDate(day)}` : fmtDate(day, { weekday: 'long', day: 'numeric', month: 'short' })}>
              <ul className="divide-y divide-line">{d.items.filter((i) => i.plannedDate === day).map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <input type="checkbox" checked={i.isDone} className="size-4 accent-[var(--brand)]" aria-label={`Mark ${i.title} done`} onChange={(e) => run(async () => { await api.patch(`/student/study-plan/${i.id}`, { isDone: e.target.checked }); s.reload(true); })} />
                  <span className={`flex-1 text-sm ${i.isDone ? 'text-muted line-through' : ''}`}>{i.title}</span><span className="text-xs text-muted">{i.durationMin} min</span>
                  <button onClick={() => run(async () => { await api.del(`/student/study-plan/${i.id}`); s.reload(true); })} className="rounded-lg p-1 text-muted hover:text-bad" aria-label={`Delete ${i.title}`}><Icon name="x" className="size-4" /></button>
                </li>
              ))}</ul>
            </Card>
          ))}</div>
        );
      }}</Async>
      <Card title="Plan a session">
        <form onSubmit={add} className="space-y-3">
          <Field label="What will you study?"><Input required minLength={2} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="SQL joins practice" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Date"><Input type="date" required value={f.plannedDate} onChange={(e) => setF({ ...f, plannedDate: e.target.value })} /></Field><Field label="Minutes"><Input type="number" min={5} max={600} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} /></Field></div>
          <Button type="submit" busy={busy} className="w-full">Add</Button>
        </form>
      </Card>
    </div>
  );
}

function Timetable() {
  const s = useLoad(() => api.get('/student/timetable'));
  return (
    <Async state={s}>{(d) => d.entries.length === 0 ? <Empty title="No timetable yet">Your instructor publishes it for the class.</Empty> : (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[1, 2, 3, 4, 5, 6, 7].map((day) => {
        const list = d.entries.filter((e) => e.day === day); if (!list.length) return null;
        const isToday = ((new Date().getDay() + 6) % 7) + 1 === day;
        return (
          <Card key={day} title={<span className="flex items-center gap-2">{DAYS[day - 1]} {isToday && <Pill tone="brand">Today</Pill>}</span>}>
            <ul className="space-y-2.5">{list.map((e) => <li key={e.id} className="flex gap-3 text-sm"><span className="w-24 shrink-0 tabular-nums text-muted">{e.starts}–{e.ends}</span><span><b>{e.subject}</b>{e.room && <span className="block text-xs text-muted">{e.room}</span>}</span></li>)}</ul>
          </Card>
        );
      })}</div>
    )}</Async>
  );
}

function Assignments() {
  const s = useLoad(() => api.get('/student/assignments'));
  const [run] = useAction();
  const TONE = { due: 'warn', overdue: 'bad', submitted: 'good' };
  return (
    <Async state={s}>{(d) => d.assignments.length === 0 ? <Empty title="No assignments">Assignments posted by your instructor appear here.</Empty> : (
      <Card pad={false}><ul className="divide-y divide-line">{d.assignments.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="min-w-0 flex-1"><p className="font-medium">{a.title}</p><p className="text-xs text-muted">{a.subject || 'General'} · due {fmtDateTime(a.dueAt)}</p></div>
          <Pill tone={TONE[a.status]}>{a.status === 'submitted' ? `Submitted ${fmtDate(a.submittedAt, { day: 'numeric', month: 'short' })}` : a.status === 'overdue' ? 'Overdue' : 'Due'}</Pill>
          {a.status !== 'submitted' && <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/student/assignments/${a.id}/submit`); s.reload(true); }, 'Marked as submitted')}>Mark submitted</Button>}
        </li>
      ))}</ul></Card>
    )}</Async>
  );
}

const TABS = [['goals', 'Goals', Goals], ['plan', 'Study plan', StudyPlan], ['timetable', 'Timetable', Timetable], ['assignments', 'Assignments', Assignments]];
export default function Planner() {
  const [tab, setTab] = useState('goals');
  const Body = TABS.find((t) => t[0] === tab)[2];
  return (
    <>
      <PageHeader title="Planner" subtitle="Goals, study sessions, your class timetable and assignments." />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">{TABS.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${tab === k ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink'}`}>{label}</button>
      ))}</div>
      <Body />
    </>
  );
}
