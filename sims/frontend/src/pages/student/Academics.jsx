import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Select, Stat, StatusChip, num, useAction, useLoad } from '../../ui';

function Predictor({ cgpa }) {
  const [target, setTarget] = useState(8.5);
  const [credits, setCredits] = useState(24);
  const s = useLoad(() => api.get(`/student/academics/predict?targetCgpa=${target || 0}&nextCredits=${credits || 24}`), [target, credits]);
  const r = s.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Target CGPA"><Input type="number" step="0.1" min={0} max={10} value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
        <Field label="Next semester credits"><Input type="number" min={1} max={60} value={credits} onChange={(e) => setCredits(e.target.value)} /></Field>
      </div>
      {s.error && <p className="text-sm text-muted">{s.error.message}</p>}
      {r && (
        <div className="rounded-xl bg-surface-2 p-4 text-sm">
          {r.alreadyGuaranteed ? <p className="text-good">You're already guaranteed {r.targetCgpa} — even a very low SGPA keeps you above it.</p>
            : !r.feasible ? <p className="text-bad">{r.targetCgpa} isn't reachable next semester. The best you can reach is <b>{num(r.highestPossibleCgpa, 2)}</b> (with a perfect 10 SGPA).</p>
              : <p>To reach <b>{r.targetCgpa}</b> from {num(cgpa, 2)}, score an SGPA of at least <b className="text-lg text-brand">{num(r.requiredSgpa, 2)}</b> next semester.</p>}
          <p className="mt-2 text-xs text-muted">Based on {r.creditsDone} verified credits so far.</p>
        </div>
      )}
    </div>
  );
}

function ClaimModal({ open, onClose, onDone, edit }) {
  const subjects = useLoad(() => api.get('/student/academics/subjects'), [open]);
  const [run, busy] = useAction();
  const [f, setF] = useState({ subjectId: '', internalObtained: '', externalObtained: '', internalMax: 40, externalMax: 60 });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const v = edit ? { ...f, ...edit } : f;
  const submit = async (e) => {
    e.preventDefault();
    const body = { internalObtained: Number(v.internalObtained), externalObtained: Number(v.externalObtained), internalMax: Number(v.internalMax), externalMax: Number(v.externalMax) };
    const ok = await run(() => (edit ? api.patch(`/student/academics/claims/${edit.id}`, body) : api.post('/student/academics/claims', { subjectId: f.subjectId, ...body })), 'Sent to your instructor for verification');
    if (ok) { onDone(); onClose(); }
  };
  const list = (subjects.data?.subjects || []).filter((s) => s.claimable);
  return (
    <Modal open={open} onClose={onClose} title={edit ? 'Correct marks claim' : 'Submit marks for verification'}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Marks you enter are <b>self-reported</b>: they appear in analytics only after your instructor verifies them.</p>
        {!edit && <Field label="Subject"><Select required value={f.subjectId} onChange={set('subjectId')}><option value="">Select…</option>{list.map((s) => <option key={s.id} value={s.id}>Sem {s.semester} · {s.code} — {s.name}{s.state === 'failed' ? ' (re-attempt)' : ''}</option>)}</Select></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Internal obtained"><Input type="number" step="0.5" min={0} required value={v.internalObtained} onChange={set('internalObtained')} /></Field>
          <Field label="Internal max"><Input type="number" min={0} value={v.internalMax} onChange={set('internalMax')} /></Field>
          <Field label="External obtained"><Input type="number" step="0.5" min={0} required value={v.externalObtained} onChange={set('externalObtained')} /></Field>
          <Field label="External max"><Input type="number" min={0} value={v.externalMax} onChange={set('externalMax')} /></Field>
        </div>
        <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Submit</Button></div>
      </form>
    </Modal>
  );
}

const gradeTone = (g) => (['O', 'A+', 'A'].includes(g) ? 'good' : ['F'].includes(g) ? 'bad' : 'muted');

export default function Academics() {
  const s = useLoad(() => api.get('/student/academics'));
  const [claim, setClaim] = useState(null);       // null | {} | {id,...}
  const [openSem, setOpenSem] = useState(null);

  return (
    <>
      <PageHeader title="Academics" subtitle="Semester results, CGPA and backlogs — verified marks only."
        action={<Button variant="secondary" onClick={() => setClaim({})}>Submit marks</Button>} />
      <Async state={s}>{(d) => (<>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="CGPA" value={num(d.cgpa, 2)} tone="brand" hint={`${d.creditsDone} credits earned`} />
          <Stat label="Latest SGPA" value={num(d.trend.at(-1)?.sgpa, 2)} hint={d.trend.length ? `Semester ${d.trend.at(-1).semester}` : ''} />
          <Stat label="Semesters" value={d.semesters.length} />
          <Stat label="Active backlogs" value={d.activeBacklogs.length} tone={d.activeBacklogs.length ? 'bad' : 'good'} hint={d.activeBacklogs.map((b) => b.code).join(', ') || 'All clear'} />
        </div>

        {d.semesters.length === 0 ? <div className="mt-6"><Empty title="No verified results yet">Once your instructor verifies your marks, your SGPA, CGPA and trends appear here.</Empty></div> : (<>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card title="SGPA & CGPA trend"><div className="h-56"><ResponsiveContainer><LineChart data={d.trend} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}><CartesianGrid vertical={false} /><XAxis dataKey="semester" tickFormatter={(v) => `S${v}`} tickLine={false} axisLine={false} /><YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tickLine={false} axisLine={false} /><Tooltip formatter={(v, n) => [num(v, 2), n.toUpperCase()]} labelFormatter={(v) => `Semester ${v}`} /><Line dataKey="sgpa" stroke="var(--brand)" strokeWidth={2.5} dot={{ r: 4 }} name="sgpa" /><Line dataKey="cgpa" stroke="var(--muted)" strokeDasharray="5 4" strokeWidth={2} dot={false} name="cgpa" /></LineChart></ResponsiveContainer></div></Card>
            <Card title="Credits earned per semester"><div className="h-56"><ResponsiveContainer><BarChart data={d.semesters} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}><CartesianGrid vertical={false} /><XAxis dataKey="semester" tickFormatter={(v) => `S${v}`} tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} /><Tooltip labelFormatter={(v) => `Semester ${v}`} /><Bar dataKey="creditsEarned" fill="var(--brand)" radius={[6, 6, 0, 0]} name="Earned" /><Bar dataKey="credits" fill="var(--line)" radius={[6, 6, 0, 0]} name="Registered" /></BarChart></ResponsiveContainer></div></Card>
          </div>

          <div className="mt-6 space-y-3">
            {[...d.semesters].reverse().map((sem) => (
              <Card key={sem.semester} pad={false}>
                <button className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left" onClick={() => setOpenSem(openSem === sem.semester ? null : sem.semester)} aria-expanded={openSem === sem.semester}>
                  <span className="font-semibold">Semester {sem.semester}</span>
                  <span className="flex items-center gap-3 text-sm"><span className="text-muted">{sem.creditsEarned}/{sem.credits} credits</span>{sem.backlogCount > 0 && <Pill tone="bad">{sem.backlogCount} backlog</Pill>}<b className="tabular-nums text-brand">SGPA {num(sem.sgpa, 2)}</b><span className="text-muted">{openSem === sem.semester ? '▴' : '▾'}</span></span>
                </button>
                {openSem === sem.semester && (
                  <div className="overflow-x-auto border-t border-line">
                    <table className="w-full min-w-[34rem] text-sm"><thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="px-5 py-2.5">Subject</th><th>Credits</th><th>Internal</th><th>External</th><th>Total</th><th className="pr-5">Grade</th></tr></thead>
                      <tbody className="divide-y divide-line">{sem.subjects.map((x) => (
                        <tr key={x.subjectId ?? x.code}><td className="px-5 py-2.5 font-medium">{x.name} <span className="text-xs text-muted">{x.code}</span></td><td>{x.credits}</td><td className="tabular-nums">{x.internal.obtained}/{x.internal.max}</td><td className="tabular-nums">{x.external.obtained}/{x.external.max}</td><td className="tabular-nums">{x.total} <span className="text-xs text-muted">({num(x.percentage)}%)</span></td><td className="pr-5"><Pill tone={gradeTone(x.grade)}>{x.grade} · {x.gradePoints}</Pill></td></tr>
                      ))}</tbody></table>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </>)}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title="GPA predictor">{d.creditsDone > 0 ? <Predictor cgpa={d.cgpa} /> : <p className="text-sm text-muted">Available after your first verified semester.</p>}</Card>
          <Card title="My submitted marks" action={<Button size="sm" variant="secondary" onClick={() => setClaim({})}>New</Button>}>
            {d.claims.length === 0 ? <p className="text-sm text-muted">Nothing awaiting verification.</p> : (
              <ul className="divide-y divide-line">{d.claims.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 text-sm">
                  <div className="min-w-0"><p className="font-medium">{c.name} <span className="text-xs text-muted">Sem {c.semester}</span></p><p className="text-xs text-muted">{c.total}/{c.internal.max + c.external.max} · grade {c.grade}{c.remarks ? ` · “${c.remarks}”` : ''}</p></div>
                  <div className="flex shrink-0 items-center gap-2"><StatusChip status={c.status} />{c.status !== 'verified' && <Button size="sm" variant="ghost" onClick={() => setClaim({ id: c.id, internalObtained: c.internal.obtained, internalMax: c.internal.max, externalObtained: c.external.obtained, externalMax: c.external.max })}>Edit</Button>}</div>
                </li>
              ))}</ul>
            )}
          </Card>
        </div>
        <ClaimModal key={claim?.id || 'new'} open={Boolean(claim)} edit={claim?.id ? claim : null} onClose={() => setClaim(null)} onDone={() => s.reload(true)} />
      </>)}</Async>
    </>
  );
}
