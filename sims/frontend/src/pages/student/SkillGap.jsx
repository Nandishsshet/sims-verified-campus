import { useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { Icon } from '../../icons';
import { Async, Button, Card, Empty, Field, Input, PageHeader, Pill, Progress, Select, Stat, fmtDate, num, useAction, useLoad } from '../../ui';
import { LEVEL_NAMES } from './shared';

function Skills({ onChange }) {
  const owned = useLoad(() => api.get('/student/skills'));
  const cat = useLoad(() => api.get('/skills'));
  const [run, busy] = useAction();
  const [skillId, setSkillId] = useState('');
  const [lvl, setLvl] = useState(3);
  const have = new Set((owned.data?.skills || []).filter((s) => s.source === 'manual').map((s) => s.skillId));

  const add = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.post('/student/skills', { skillId, proficiency: Number(lvl) }), 'Skill added (self-declared)');
    if (ok) { setSkillId(''); owned.reload(true); onChange(); }
  };
  const change = (s, p) => run(async () => { await api.patch(`/student/skills/${s.id}`, { proficiency: Number(p) }); owned.reload(true); onChange(); });
  const del = (s) => run(async () => { await api.del(`/student/skills/${s.id}`); owned.reload(true); onChange(); }, 'Removed');

  return (
    <Card title="My skills">
      <p className="mb-4 text-sm text-muted">Skills proven by a <b>verified</b> certificate or project count fully. Self-declared skills show up in your plan but are marked until something verifies them.</p>
      <form onSubmit={add} className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1"><Field label="Add a skill"><Select required value={skillId} onChange={(e) => setSkillId(e.target.value)}><option value="">Select…</option>{(cat.data?.skills || []).filter((s) => !have.has(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field></div>
        <div className="w-44"><Field label="Level"><Select value={lvl} onChange={(e) => setLvl(e.target.value)}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {LEVEL_NAMES[n]}</option>)}</Select></Field></div>
        <Button type="submit" busy={busy}>Add</Button>
      </form>
      <Async state={owned}>{(d) => d.skills.length === 0 ? <p className="text-sm text-muted">No skills yet — add one above or upload a certificate.</p> : (
        <ul className="divide-y divide-line">{d.skills.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
            <span className="min-w-0 flex-1"><b>{s.name}</b> <span className="text-xs text-muted">{s.category}</span>{s.evidence && <span className="block text-xs text-muted">via {s.evidence}</span>}</span>
            {s.verified ? <Pill tone="good">✓ Verified</Pill> : s.source === 'manual' ? <Pill tone="warn">Self-declared</Pill> : <Pill tone="warn">Awaiting verification</Pill>}
            {s.source === 'manual' ? (
              <>
                <select aria-label={`Level of ${s.name}`} value={s.proficiency} onChange={(e) => change(s, e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1 text-xs">{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {LEVEL_NAMES[n]}</option>)}</select>
                <button onClick={() => del(s)} className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-bad" aria-label={`Remove ${s.name}`}><Icon name="trash" className="size-4" /></button>
              </>
            ) : <span className="w-24 text-right text-xs text-muted">Level {s.proficiency}</span>}
          </li>
        ))}</ul>
      )}</Async>
    </Card>
  );
}

export default function SkillGap() {
  const roles = useLoad(() => api.get('/career-roles'));
  const target = useLoad(() => api.get('/student/target-role'));
  const [hours, setHours] = useState(6);
  const gap = useLoad(() => api.get('/student/skill-gap'), [target.data?.role?.id]);
  const road = useLoad(() => api.get(`/student/skill-gap/roadmap?hoursPerWeek=${hours || 6}`), [hours, target.data?.role?.id]);
  const hist = useLoad(() => api.get('/student/skill-gap/history'), [target.data?.role?.id]);
  const [run] = useAction();
  const refresh = () => { gap.reload(true); road.reload(true); hist.reload(true); };

  const pick = (roleId) => run(async () => { await api.put('/student/target-role', { roleId }); await target.reload(true); }, 'Target role updated');
  const role = target.data?.role;

  return (
    <>
      <PageHeader title="Skill Gap Analyzer" subtitle="See how close you are to a career role and get a week-by-week plan to close the gap."
        action={<Select aria-label="Target role" value={role?.id || ''} onChange={(e) => e.target.value && pick(e.target.value)} className="!w-auto"><option value="">Choose target role…</option>{(roles.data?.roles || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>} />

      {!role ? (
        <Async state={roles}>{(d) => (
          <Empty title="Pick the role you're aiming for">We compare your skills with what the role needs and build a roadmap.
            <div className="mx-auto mt-5 grid max-w-3xl gap-3 text-left sm:grid-cols-2">{d.roles.map((r) => (
              <button key={r.id} onClick={() => pick(r.id)} className="rounded-xl border border-line p-4 text-left hover:border-brand hover:bg-brand-soft">
                <b className="text-ink">{r.name}</b><span className="block text-xs">{r.skillCount} skills</span><span className="mt-1 block text-sm">{r.description}</span></button>
            ))}</div>
          </Empty>
        )}</Async>
      ) : (<>
        <Async state={gap}>{(g) => g.role && (<>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Role" value={<span className="text-xl">{g.role.name}</span>} hint={`${g.radar.length} skills required`} />
            <Stat label="Skill gap" value={`${num(g.gapPct)}%`} tone={g.gapPct <= 30 ? 'good' : g.gapPct <= 60 ? 'warn' : 'bad'} hint="including self-declared skills" />
            <Stat label="Verified gap" value={`${num(g.verifiedGapPct)}%`} tone={g.verifiedGapPct <= 30 ? 'good' : g.verifiedGapPct <= 60 ? 'warn' : 'bad'} hint="proved by verified evidence" />
            <Stat label="Readiness" value={`${num(g.readinessPct, 0)}%`} tone="brand" hint="declared + verified" />
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card title="Skill radar">
              <div className="h-80"><ResponsiveContainer>
                <RadarChart data={g.radar} outerRadius="72%"><PolarGrid /><PolarAngleAxis dataKey="skill" /><PolarRadiusAxis angle={60} domain={[0, 5]} tickCount={6} axisLine={false} tick={{ fontSize: 10 }} />
                  <Radar name="Required" dataKey="required" stroke="var(--muted)" fill="var(--muted)" fillOpacity={0.12} strokeDasharray="4 3" />
                  <Radar name="You (declared)" dataKey="have" stroke="var(--brand)" fill="var(--brand)" fillOpacity={0.25} />
                  <Radar name="You (verified)" dataKey="haveVerified" stroke="var(--good)" fill="var(--good)" fillOpacity={0.3} />
                  <Legend /><Tooltip /></RadarChart></ResponsiveContainer></div>
            </Card>
            <Card title="Biggest gaps first">
              {g.missing.length === 0 ? <p className="text-sm text-good">You meet every requirement for this role. 🎉</p> : (
                <ul className="space-y-4">{g.missing.map((m) => (
                  <li key={m.skillId}><div className="mb-1.5 flex items-center justify-between gap-2 text-sm"><b>{m.skill}</b><span className="text-xs text-muted">Level {m.have} of {m.required} needed{m.haveVerified < m.have ? ` · ${m.haveVerified} verified` : ''}</span></div><Progress value={m.coveragePct} label={m.skill} /></li>
                ))}</ul>
              )}
            </Card>
          </div>
        </>)}</Async>

        <Card className="mt-6" title="Learning roadmap" action={<label className="flex items-center gap-2 text-xs text-muted">Hours per week<Input type="number" min={1} max={60} value={hours} onChange={(e) => setHours(e.target.value)} className="!w-16 !py-1" /></label>}>
          <Async state={road}>{(r) => r.phases.length === 0 ? <p className="text-sm text-good">Nothing to learn — you already meet the requirements.</p> : (<>
            <p className="mb-5 text-sm text-muted">About <b className="text-ink">{r.totalWeeks} weeks</b> · {r.totalHours} hours at {r.hoursPerWeek} h/week, ordered by what matters most for the role.</p>
            <ol className="relative space-y-5 border-l-2 border-line pl-6">{r.phases.map((p) => (
              <li key={p.skillId} className="relative">
                <span className="absolute -left-[2.15rem] flex size-6 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-ink">{p.priority}</span>
                <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">{p.skill}</h3><span className="text-xs text-muted">Weeks {p.startWeek}–{p.endWeek} · {p.hours} h · level {p.fromLevel} → {p.toLevel}/{p.requiredLevel}</span></div>
                {p.resources.length ? <ul className="mt-2 space-y-1.5">{p.resources.map((x) => (
                  <li key={x.url + x.title}><a href={x.url} target="_blank" rel="noopener noreferrer" className="group flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2 text-sm hover:border-brand"><span><span className="font-medium group-hover:text-brand">{x.title}</span><span className="block text-xs text-muted">{x.provider}{x.hours ? ` · ~${x.hours} h` : ''}</span></span><Icon name="link" className="size-4 shrink-0 text-muted" /></a></li>
                ))}</ul> : <p className="mt-1.5 text-sm text-muted">{p.note}</p>}
                {!p.fullyCovered && p.resources.length > 0 && <p className="mt-1.5 text-xs text-warn">These courses reach level {p.toLevel}; practise with a project to get to {p.requiredLevel}.</p>}
              </li>
            ))}</ol>
          </>)}</Async>
        </Card>

        <div className="mt-6"><Card title="Progress over time">
          <Async state={hist}>{(h) => h.history.length < 2 ? <p className="text-sm text-muted">Come back after you add certificates, projects or skills — each day you open this page records a point so you can see your gap shrink.{h.history.length === 1 && ` Today: ${num(h.history[0].gapPct)}%.`}</p> : (
            <div className="h-60"><ResponsiveContainer><LineChart data={h.history} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}><CartesianGrid vertical={false} /><XAxis dataKey="date" tickFormatter={(d) => fmtDate(d, { day: 'numeric', month: 'short' })} tickLine={false} axisLine={false} /><YAxis domain={[0, 100]} tickLine={false} axisLine={false} unit="%" /><Tooltip formatter={(v) => `${num(v)}%`} /><Legend />
              <Line dataKey="gapPct" name="Gap" stroke="var(--brand)" strokeWidth={2.5} dot={{ r: 3 }} /><Line dataKey="verifiedGapPct" name="Verified gap" stroke="var(--good)" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div>
          )}</Async>
        </Card></div>
        <div className="mt-6"><Skills onChange={refresh} /></div>
      </>)}
    </>
  );
}
