import { useState } from 'react';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Progress, Select, Stat, Textarea, fmtDate, num, useAction, useLoad } from '../../ui';

const DOT = { present: 'bg-good', late: 'bg-warn', excused: 'bg-info', absent: 'bg-bad' };

/** Month grid; each day shows coloured dots for the recorded periods. */
function Calendar({ month, days, onMonth }) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;                      // Monday first
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = Object.fromEntries(days.map((d) => [d.date, d.records]));
  const shift = (n) => { const t = new Date(Date.UTC(y, m - 1 + n, 1)); onMonth(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`); };
  const [sel, setSel] = useState(null);
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const iso = (d) => `${month}-${String(d).padStart(2, '0')}`;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => shift(-1)} aria-label="Previous month">‹</Button>
        <b className="text-sm">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b>
        <Button variant="ghost" size="sm" onClick={() => shift(1)} aria-label="Next month">›</Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium uppercase text-muted">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i}>{d}</div>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const recs = byDate[iso(d)];
          return (
            <button key={i} disabled={!recs} onClick={() => setSel(sel === iso(d) ? null : iso(d))}
              className={`flex aspect-square flex-col items-center justify-center rounded-lg border text-xs transition ${sel === iso(d) ? 'border-brand bg-brand-soft' : 'border-transparent bg-surface-2'} ${recs ? 'hover:border-brand' : 'opacity-50'}`}>
              <span className="tabular-nums">{d}</span>
              {recs && <span className="mt-0.5 flex gap-0.5">{recs.slice(0, 4).map((r, k) => <i key={k} className={`size-1.5 rounded-full ${DOT[r.status]} ${r.verified ? '' : 'ring-1 ring-warn'}`} />)}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">{Object.entries(DOT).map(([k, c]) => <span key={k} className="flex items-center gap-1.5"><i className={`size-2 rounded-full ${c}`} />{k}</span>)}<span>ringed = pending review</span></div>
      {sel && <ul className="mt-3 divide-y divide-line rounded-xl border border-line text-sm">{byDate[sel].map((r, i) => <li key={i} className="flex items-center justify-between px-3 py-2"><span>{r.subject} <span className="text-xs text-muted">· period {r.period}</span></span><span className="flex items-center gap-2"><Pill tone={r.status === 'present' ? 'good' : r.status === 'absent' ? 'bad' : 'warn'}>{r.status}</Pill>{!r.verified && <Pill tone="warn">pending</Pill>}</span></li>)}</ul>}
    </div>
  );
}

function CanMiss({ overall }) {
  const [remaining, setRemaining] = useState(20);
  const [threshold, setThreshold] = useState(75);
  const s = useLoad(() => api.get(`/student/attendance/can-miss?remaining=${remaining || 0}&threshold=${threshold}`), [remaining, threshold]);
  const r = s.data;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Using your verified attendance ({overall.attended}/{overall.held}). How many of the classes still to come can you skip?</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Classes remaining"><Input type="number" min={0} max={500} value={remaining} onChange={(e) => setRemaining(e.target.value)} /></Field>
        <Field label="Required %"><Input type="number" min={1} max={99} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
      </div>
      {r && (
        <div className="rounded-xl bg-surface-2 p-4 text-sm">
          {r.missableOfRemaining == null
            ? <p className="text-bad">Even attending every remaining class you can't reach {threshold}% — talk to your instructor.</p>
            : <p>You can miss at most <b className="text-lg text-brand">{r.missableOfRemaining}</b> of the next {remaining} classes and still finish at ≥ {threshold}%.</p>}
          <p className="mt-2 text-xs text-muted">Right now: {num(r.percentage)}% · {r.canMiss > 0 ? `${r.canMiss} class(es) can be missed before dropping below ${threshold}%` : r.toRecover > 0 ? `attend the next ${r.toRecover} in a row to recover` : ''}</p>
        </div>
      )}
    </div>
  );
}

function ClaimModal({ open, onClose, subjects, onDone }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ subjectId: '', date: new Date().toISOString().slice(0, 10), period: 1, note: '' });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.post('/student/attendance/claims', { ...f, period: Number(f.period) }), 'Sent to your instructor for verification');
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Report an unrecorded class">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Attended a class that isn't on your record? Your instructor will review it; it counts only once verified.</p>
        <Field label="Subject"><Select required value={f.subjectId} onChange={set('subjectId')}><option value="">Select…</option>{subjects.map((s) => <option key={s.subjectId} value={s.subjectId}>{s.code} — {s.name}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Date"><Input type="date" required max={new Date().toISOString().slice(0, 10)} value={f.date} onChange={set('date')} /></Field><Field label="Period"><Input type="number" min={1} max={12} value={f.period} onChange={set('period')} /></Field></div>
        <Field label="Why was it missed?"><Textarea required minLength={3} maxLength={300} value={f.note} onChange={set('note')} placeholder="e.g. Lab session — attendance sheet wasn't collected" /></Field>
        <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Submit claim</Button></div>
      </form>
    </Modal>
  );
}

export default function Attendance() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [sem, setSem] = useState('current');
  const [claim, setClaim] = useState(false);
  const s = useLoad(() => api.get(`/student/attendance?semester=${sem}&month=${month}`), [month, sem]);

  return (
    <>
      <PageHeader title="Attendance" subtitle="Only instructor-verified classes count towards your percentage."
        action={<div className="flex gap-2"><Select value={sem} onChange={(e) => setSem(e.target.value)} className="!w-auto" aria-label="Semester"><option value="current">Current semester</option><option value="all">All semesters</option></Select><Button variant="secondary" onClick={() => setClaim(true)}>Report missing class</Button></div>} />
      <Async state={s}>{(d) => (<>
        {d.overall.held === 0 ? <Empty title="No verified attendance yet">Your instructor records attendance per class; it shows up here automatically.</Empty> : (<>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Overall" value={`${num(d.overall.percentage)}%`} tone={d.overall.percentage >= d.threshold ? 'good' : 'bad'} hint={`${d.overall.attended} of ${d.overall.held} classes`} />
            <Stat label="Can miss" value={d.overall.canMiss} hint={`before dropping below ${d.threshold}%`} />
            <Stat label="To recover" value={d.overall.toRecover} hint="consecutive classes to attend" tone={d.overall.toRecover ? 'warn' : 'default'} />
            <Stat label="Pending claims" value={d.pendingClaims} hint="awaiting your instructor" />
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card title="By subject">
              <ul className="space-y-4">{d.subjects.map((x) => (
                <li key={x.subjectId}>
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-sm"><span className="font-medium">{x.name} <span className="text-xs text-muted">{x.code}</span></span><span className={`tabular-nums font-semibold ${x.alert ? 'text-bad' : ''}`}>{num(x.percentage)}%</span></div>
                  <Progress value={x.percentage} label={x.name} />
                  <p className="mt-1 text-xs text-muted">{x.attended}/{x.held} · {x.alert ? `attend next ${x.toRecover} to reach ${d.threshold}%` : `can miss ${x.canMiss}`}</p>
                </li>
              ))}</ul>
            </Card>
            <div className="space-y-6">
              <Card title="Calendar"><Calendar month={d.calendar.month} days={d.calendar.days} onMonth={setMonth} /></Card>
              <Card title="Can I skip classes?"><CanMiss overall={d.overall} /></Card>
            </div>
          </div>
        </>)}
        <ClaimModal open={claim} onClose={() => setClaim(false)} subjects={d.subjects} onDone={() => s.reload(true)} />
      </>)}</Async>
    </>
  );
}
