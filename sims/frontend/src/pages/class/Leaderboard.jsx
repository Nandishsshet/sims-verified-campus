import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Input, Modal, PageHeader, Select, num, useAction, useLoad } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { download } from './shared';

const KEYS = ['marks', 'attendance', 'certificates', 'skills', 'resume', 'activity'];
const LABEL = { marks: 'Marks', attendance: 'Attendance', certificates: 'Certificates', skills: 'Skills', resume: 'Resume', activity: 'Activities' };
const SOURCE = { class: 'Custom weights for this class', college: 'College default weights', default: 'Standard weights' };

/** Six whole-number weights that must add up to exactly 100. */
function WeightsEditor({ cfg, onClose, onSaved }) {
  const { url } = useClass();
  const [run, busy] = useAction();
  const [w, setW] = useState(() => Object.fromEntries(KEYS.map((k) => [k, String(cfg.weights[k])])));
  const sum = KEYS.reduce((a, k) => a + (Number(w[k]) || 0), 0);
  const valid = sum === 100 && KEYS.every((k) => Number.isInteger(Number(w[k])) && Number(w[k]) >= 0);

  const save = async () => { if (await run(() => api.put(url('/leaderboard-config'), Object.fromEntries(KEYS.map((k) => [k, Number(w[k])]))), 'Weights saved')) onSaved(); };
  const reset = async () => { if (await run(() => api.del(url('/leaderboard-config')).then(() => true), 'Back to the default weights')) onSaved(); };

  return (
    <Modal open onClose={onClose} title="Leaderboard weights">
      <div className="space-y-4">
        <p className="text-sm text-muted">Decide how much each area counts towards the class score. Only verified data is used.</p>
        <div className="grid grid-cols-2 gap-3">
          {KEYS.map((k) => <label key={k} className="block text-sm"><span className="mb-1 block font-medium">{LABEL[k]} (%)</span><Input type="number" min="0" max="100" step="1" value={w[k]} onChange={(e) => setW({ ...w, [k]: e.target.value })} /></label>)}
        </div>
        <p className={`text-sm font-medium ${valid ? 'text-good' : 'text-bad'}`} role="status">Total: {sum}% {valid ? '✓' : sum > 100 ? `— ${sum - 100} over` : `— ${100 - sum} short`}</p>
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" busy={busy} onClick={reset}>Reset to default</Button>
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!valid} onClick={save}>Save weights</Button></div>
        </div>
      </div>
    </Modal>
  );
}

export default function Leaderboard() {
  const { url, current } = useClass();
  const [sem, setSem] = useState('');
  const [edit, setEdit] = useState(false);
  const [run, busy] = useAction();
  const lb = useLoad(() => api.get(url(`/leaderboard${sem ? `?semester=${sem}` : ''}`)), [current.id, sem]);
  const cfg = useLoad(() => api.get(url('/leaderboard-config')), [current.id]);
  useEffect(() => { setSem(''); }, [current.id]);

  const saved = () => { setEdit(false); lb.reload(true); cfg.reload(true); };
  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Leaderboard" subtitle="Weighted score from verified marks, attendance, certificates, skills, resume and activities."
        action={<div className="flex gap-2">
          <Button variant="secondary" size="sm" busy={busy} onClick={() => run(() => download(url('/export/leaderboard'), 'class-leaderboard.csv'))}>Export CSV</Button>
          <Button size="sm" disabled={!cfg.data} onClick={() => setEdit(true)}>Edit weights</Button></div>} />

      <Async state={lb}>{({ board, weights, weightsSource }) => (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <Select aria-label="Semester filter" className="!w-auto" value={sem} onChange={(e) => setSem(e.target.value)}>
              <option value="">All semesters (cumulative)</option>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1} only</option>)}
            </Select>
            <span className="text-muted">{SOURCE[weightsSource] || weightsSource}: {KEYS.map((k) => `${LABEL[k]} ${weights[k]}%`).join(' · ')}</span>
          </div>
          {board.length === 0 ? <Empty title="No students yet">Approved students are ranked here.</Empty> : (
            <Card pad={false}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    <tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Student</th><th className="px-4 py-3 text-right">Score</th>{KEYS.map((k) => <th key={k} className="hidden px-3 py-3 text-right lg:table-cell">{LABEL[k]}</th>)}<th className="px-4 py-3 text-right">CGPA</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {board.map((r) => (
                      <tr key={r.id} className="hover:bg-surface-2/60">
                        <td className="px-4 py-3"><span className={`inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold ${r.rank <= 3 ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-muted'}`}>{r.rank}</span></td>
                        <td className="px-4 py-3"><Link to={`/class/students/${r.id}`} className="font-medium hover:text-brand">{r.name}</Link><div className="text-xs text-muted">{r.rollNumber || '—'}</div></td>
                        <td className="px-4 py-3 text-right text-base font-semibold tabular-nums">{num(r.score)}</td>
                        {KEYS.map((k) => <td key={k} className="hidden px-3 py-3 text-right tabular-nums text-muted lg:table-cell">{num(r.components[k], 0)}</td>)}
                        <td className="px-4 py-3 text-right tabular-nums">{num(r.cgpa, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}</Async>
      {edit && cfg.data && <WeightsEditor cfg={cfg.data} onClose={() => setEdit(false)} onSaved={saved} />}
    </>
  );
}
