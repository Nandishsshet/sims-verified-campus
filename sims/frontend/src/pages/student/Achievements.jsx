import { useState } from 'react';
import { api } from '../../api';
import { Icon } from '../../icons';
import { Async, Card, PageHeader, Pill, Progress, Select, Stat, fmtDate, num, useLoad } from '../../ui';

const BADGE_ICON = { award: 'award', medal: 'award', 'calendar-check': 'calendar', 'graduation-cap': 'book', 'shield-check': 'shield', hammer: 'folder', star: 'spark', 'file-text': 'file', trophy: 'trophy' };

function Badges() {
  const s = useLoad(() => api.get('/student/badges'));
  return (
    <Card title="Badges">
      <Async state={s}>{(d) => (
        <>
          <p className="mb-4 text-sm text-muted">{d.badges.filter((b) => b.earned).length} of {d.badges.length} earned — badges are awarded automatically from verified data.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{d.badges.map((b) => (
            <div key={b.code} className={`rounded-2xl border p-4 text-center ${b.earned ? 'border-brand/40 bg-brand-soft' : 'border-line opacity-60'}`} title={b.description}>
              <div className={`mx-auto flex size-11 items-center justify-center rounded-full ${b.earned ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-muted'}`}><Icon name={BADGE_ICON[b.icon] || 'award'} /></div>
              <p className="mt-2 text-sm font-semibold">{b.name}</p><p className="mt-0.5 text-xs text-muted">{b.earned ? `Earned ${fmtDate(b.awardedAt, { day: 'numeric', month: 'short' })}` : b.description}</p>
            </div>
          ))}</div>
        </>
      )}</Async>
    </Card>
  );
}

function Placement() {
  const s = useLoad(() => api.get('/student/placement-readiness'));
  return (
    <Card title="Placement readiness">
      <Async state={s}>{(d) => (
        <>
          <div className="mb-5 flex items-end gap-3"><span className="text-5xl font-semibold tabular-nums tracking-tight text-brand">{num(d.score, 0)}</span><span className="pb-1.5 text-sm text-muted">/ 100 — verified data only</span></div>
          <ul className="space-y-4">{d.breakdown.map((p) => (
            <li key={p.key}><div className="mb-1 flex justify-between gap-3 text-sm"><span>{p.label}</span><span className="tabular-nums text-muted">{num(p.value, 0)}% × {p.weight}% = <b className="text-ink">{num(p.contribution)}</b></span></div><Progress value={p.value} label={p.label} /></li>
          ))}</ul>
          {d.backlogPenalty > 0 && <p className="mt-4 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">−{d.backlogPenalty} points for {d.activeBacklogs} active backlog{d.activeBacklogs > 1 ? 's' : ''}.</p>}
        </>
      )}</Async>
    </Card>
  );
}

function Leaderboard() {
  const [sem, setSem] = useState('');
  const s = useLoad(() => api.get(`/student/leaderboard${sem ? `?semester=${sem}` : ''}`), [sem]);
  const COMP = { marks: 'Marks', attendance: 'Attendance', certificates: 'Certificates', skills: 'Skills', resume: 'Resume', activity: 'Activities' };
  return (
    <Card title="Class leaderboard" action={<Select aria-label="Semester" value={sem} onChange={(e) => setSem(e.target.value)} className="!w-auto !py-1 text-xs"><option value="">Overall</option>{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>Semester {n}</option>)}</Select>}>
      <Async state={s}>{(d) => (
        <>
          {d.me && (
            <div className="mb-5 rounded-2xl bg-brand-soft p-4">
              <div className="flex items-end justify-between"><div><p className="text-xs font-medium uppercase tracking-wide text-muted">Your rank</p><p className="text-3xl font-semibold text-brand">#{d.me.rank} <span className="text-base font-normal text-muted">of {d.classSize}</span></p></div><div className="text-right"><p className="text-xs text-muted">Score</p><p className="text-2xl font-semibold tabular-nums">{num(d.me.total)}</p></div></div>
              <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">{Object.entries(COMP).map(([k, label]) => (
                <li key={k}><div className="mb-0.5 flex justify-between text-xs"><span>{label}</span><span className="tabular-nums text-muted">{num(d.me.components?.[k], 0)}</span></div><Progress value={d.me.components?.[k]} tone="brand" label={label} /></li>
              ))}</ul>
              <p className="mt-3 text-xs text-muted">Weights: {Object.entries(d.weights).map(([k, v]) => `${COMP[k] || k} ${v}%`).join(' · ')}</p>
            </div>
          )}
          <ol className="divide-y divide-line">{d.board.map((r) => (
            <li key={`${r.rank}-${r.name}`} className={`flex items-center gap-3 py-2.5 text-sm ${r.isMe ? '-mx-2 rounded-xl bg-brand-soft px-2 font-semibold' : ''}`}>
              <span className={`w-8 text-center tabular-nums ${r.rank <= 3 ? 'font-bold text-brand' : 'text-muted'}`}>{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</span>
              <span className="flex-1">{r.name}{r.isMe && <span className="ml-2"><Pill tone="brand">You</Pill></span>}</span><span className="tabular-nums">{num(r.total)}</span>
            </li>
          ))}</ol>
          <p className="mt-3 text-xs text-muted">Other students' marks, attendance and certificates are never shown here.</p>
        </>
      )}</Async>
    </Card>
  );
}

export default function Achievements() {
  return (
    <>
      <PageHeader title="Achievements" subtitle="Badges, placement readiness and where you stand in your class." />
      <div className="grid gap-6 lg:grid-cols-2"><Placement /><Badges /></div>
      <div className="mt-6"><Leaderboard /></div>
    </>
  );
}
