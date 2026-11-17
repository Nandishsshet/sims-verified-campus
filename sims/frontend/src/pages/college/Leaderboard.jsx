import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Input, Modal, PageHeader, Pill, Select, num, useAction, useDebounced, useLoad } from '../../ui';
import { Tabs, download } from '../class/shared';
import { METRICS, RankBadge, ScoreText } from './shared';

const KEYS = ['marks', 'attendance', 'certificates', 'skills', 'resume', 'activity'];
const LABEL = { marks: 'Marks', attendance: 'Attendance', certificates: 'Certificates', skills: 'Skills', resume: 'Resume', activity: 'Activities' };
const SOURCE = { college: 'College default weights', default: 'Standard weights' };
const PAGE = 25;

/** College-wide default weights. Classes that set their own weights keep them. */
function WeightsEditor({ onClose, onSaved }) {
  const cfg = useLoad(() => api.get('/college/leaderboard-config'));
  const [run, busy] = useAction();
  const [w, setW] = useState(null);
  useEffect(() => { if (cfg.data && !w) setW(Object.fromEntries(KEYS.map((k) => [k, String(cfg.data.weights[k])]))); }, [cfg.data, w]);
  const sum = w ? KEYS.reduce((a, k) => a + (Number(w[k]) || 0), 0) : 0;
  const valid = w && sum === 100 && KEYS.every((k) => Number.isInteger(Number(w[k])) && Number(w[k]) >= 0);

  const save = async () => { if (await run(() => api.put('/college/leaderboard-config', Object.fromEntries(KEYS.map((k) => [k, Number(w[k])]))), 'Default weights saved')) onSaved(); };
  const reset = async () => { if (await run(() => api.del('/college/leaderboard-config'), 'Back to the standard weights')) onSaved(); };

  return (
    <Modal open onClose={onClose} title="College default weights">
      {!w ? <p className="text-sm text-muted">Loading…</p> : (
        <div className="space-y-4">
          <p className="text-sm text-muted">Used by every class that has not set its own weights{cfg.data.overridden > 0 ? <> — <b className="text-ink">{cfg.data.overridden} class{cfg.data.overridden === 1 ? '' : 'es'}</b> currently override them</> : ''}. Whole numbers that add up to 100.</p>
          <div className="grid grid-cols-2 gap-3">
            {KEYS.map((k) => <label key={k} className="block text-sm"><span className="mb-1 block font-medium">{LABEL[k]} (%)</span><Input type="number" min="0" max="100" step="1" value={w[k]} onChange={(e) => setW({ ...w, [k]: e.target.value })} /></label>)}
          </div>
          <p className={`text-sm font-medium ${valid ? 'text-good' : 'text-bad'}`} role="status">Total: {sum}% {valid ? '✓' : sum > 100 ? `— ${sum - 100} over` : `— ${100 - sum} short`}</p>
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" busy={busy} disabled={cfg.data.source === 'default'} onClick={reset}>Reset to standard</Button>
            <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!valid} onClick={save}>Save weights</Button></div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function StudentsTab({ onEdit, reloadKey }) {
  const [f, setF] = useState({ departmentId: '', classId: '', semester: '', q: '' });
  const [offset, setOffset] = useState(0);
  const q = useDebounced(f.q, 300);
  const [run, busy] = useAction();
  const depts = useLoad(() => api.get('/college/departments'));
  const classes = useLoad(() => api.get(`/college/leaderboard/classes${f.departmentId ? `?departmentId=${f.departmentId}` : ''}`), [f.departmentId]);
  const qs = new URLSearchParams({ limit: PAGE, offset, ...(f.departmentId && { departmentId: f.departmentId }), ...(f.classId && { classId: f.classId }), ...(f.semester && { semester: f.semester }), ...(q && { q }) }).toString();
  const lb = useLoad(() => api.get(`/college/leaderboard/students?${qs}`), [qs, reloadKey]);
  const set = (k) => (e) => { setOffset(0); setF((p) => ({ ...p, [k]: e.target.value, ...(k === 'departmentId' ? { classId: '' } : {}) })); };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Department" className="!w-auto" value={f.departmentId} onChange={set('departmentId')}><option value="">All departments</option>{depts.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select aria-label="Class" className="!w-auto" value={f.classId} onChange={set('classId')}><option value="">All classes</option>{classes.data?.board.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Semester" className="!w-auto" value={f.semester} onChange={set('semester')}><option value="">All semesters</option>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1} only</option>)}</Select>
        <Input aria-label="Search students" placeholder="Search name or roll number" className="!w-56" value={f.q} onChange={set('q')} />
        <Button variant="secondary" size="sm" className="ml-auto" busy={busy} onClick={() => run(() => download('/college/export/students', 'college-students.csv'), 'Students exported')}>Export CSV</Button>
      </div>
      <Async state={lb}>{({ board, total, weights, weightsSource }) => (
        <>
          <p className="mb-3 text-sm text-muted">{SOURCE[weightsSource]}: {KEYS.map((k) => `${LABEL[k]} ${weights[k]}%`).join(' · ')}. Classes with their own weights are scored with the college default here so every student is compared on the same scale.</p>
          {board.length === 0 ? <Empty title={total === 0 && !f.q && !f.departmentId && !f.classId ? 'No students yet' : 'No students match'}>Approved students are ranked here once their class is active.</Empty> : (
            <Card pad={false}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Student</th><th className="px-4 py-3">Class</th><th className="px-4 py-3 text-right">Score</th>{KEYS.map((k) => <th key={k} className="hidden px-3 py-3 text-right xl:table-cell">{LABEL[k]}</th>)}<th className="px-4 py-3 text-right">CGPA</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {board.map((r) => (
                      <tr key={r.id} className="hover:bg-surface-2/60">
                        <td className="px-4 py-3"><RankBadge rank={r.rank} /></td>
                        <td className="px-4 py-3"><div className="font-medium">{r.name}</div><div className="text-xs text-muted">{r.rollNumber || '—'}</div></td>
                        <td className="px-4 py-3"><div>{r.class.name}</div><div className="text-xs text-muted">{r.department}</div></td>
                        <td className="px-4 py-3 text-right text-base font-semibold tabular-nums">{num(r.score)}</td>
                        {KEYS.map((k) => <td key={k} className="hidden px-3 py-3 text-right tabular-nums text-muted xl:table-cell">{num(r.components[k], 0)}</td>)}
                        <td className="px-4 py-3 text-right tabular-nums">{num(r.cgpa, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
                <span className="text-muted">{offset + 1}–{offset + board.length} of {total}</span>
                <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button><Button size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button></div>
              </div>
            </Card>
          )}
        </>
      )}</Async>
      <div className="mt-3"><button onClick={onEdit} className="text-xs font-medium text-brand hover:underline">Edit college default weights</button></div>
    </>
  );
}

/** Departments and classes share one table: ranked by score, groups without data listed last. */
function GroupTab({ kind }) {
  const q = useLoad(() => api.get(`/college/leaderboard/${kind}`));
  const dept = kind === 'departments';
  return (
    <Async state={q}>{({ board, college }) => board.length === 0 ? <Empty title={`No ${kind} yet`} /> : (
      <Card pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">{dept ? 'Department' : 'Class'}</th><th className="px-3 py-3 text-right">Students</th><th className="px-3 py-3 text-right">Attendance</th><th className="px-3 py-3 text-right">SGPA</th><th className="px-3 py-3">Weak areas</th><th className="px-4 py-3 text-right">Score</th></tr></thead>
            <tbody className="divide-y divide-line">
              {board.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2/60">
                  <td className="px-4 py-3"><RankBadge rank={r.rank} /></td>
                  <td className="px-4 py-3">{dept ? <Link to={`/college/departments/${r.id}`} className="font-medium hover:text-brand">{r.name}</Link> : <span className="font-medium">{r.name}</span>} <span className="text-xs text-muted">{dept ? r.code : r.department}</span>{!dept && <div className="text-xs text-muted">{r.instructor || 'No instructor'} · semester {r.semester}</div>}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{r.students}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{r.metrics ? `${num(r.metrics.attendancePct)}%` : '—'}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{r.metrics ? num(r.metrics.avgSgpa, 2) : '—'}</td>
                  <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{r.weak.length ? r.weak.map((k) => <Pill key={k} tone="bad">{METRICS[k]}</Pill>) : <span className="text-muted">—</span>}</div></td>
                  <td className="px-4 py-3 text-right"><ScoreText score={r.score} className="text-base" /></td>
                </tr>
              ))}
              {dept && <tr className="bg-surface-2/60 font-medium"><td className="px-4 py-3" /><td className="px-4 py-3" colSpan={5}>College overall</td><td className="px-4 py-3 text-right"><ScoreText score={college.score} className="text-base" /></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    )}</Async>
  );
}

export default function Leaderboard() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'students';
  const [edit, setEdit] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <PageHeader title="Leaderboards" subtitle="Students, classes and departments ranked on verified data only."
        action={<Button size="sm" variant="secondary" onClick={() => setEdit(true)}>Default weights</Button>} />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'students', label: 'Students' }, { id: 'classes', label: 'Classes' }, { id: 'departments', label: 'Departments' }]} />
      {tab === 'departments' ? <GroupTab kind="departments" /> : tab === 'classes' ? <GroupTab kind="classes" /> : <StudentsTab onEdit={() => setEdit(true)} reloadKey={reloadKey} />}
      {edit && <WeightsEditor onClose={() => setEdit(false)} onSaved={() => { setEdit(false); setReloadKey((k) => k + 1); }} />}
    </>
  );
}
