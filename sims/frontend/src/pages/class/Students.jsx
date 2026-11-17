import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Input, PageHeader, Pill, num, useAction, useDebounced, useLoad } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { RiskPill, download, pctTone } from './shared';

export default function Students() {
  const { url, current } = useClass();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [run, busy] = useAction();
  const s = useLoad(() => api.get(url(`/students${dq ? `?q=${encodeURIComponent(dq)}` : ''}`)), [current.id, dq]);

  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Students" subtitle="Ranks and risk use verified data only."
        action={<Button variant="secondary" size="sm" busy={busy} onClick={() => run(() => download(url('/export/students'), 'class-students.csv'))}>Export CSV</Button>} />
      <div className="mb-4 max-w-sm"><Input type="search" aria-label="Search students" placeholder="Search by name or roll number" value={q} onChange={(e) => setQ(e.target.value)} /></div>

      <Async state={s}>{({ students, pendingJoinRequests }) => (
        <>
          {pendingJoinRequests > 0 && (
            <p className="mb-4 rounded-xl bg-warn-soft px-4 py-2.5 text-sm text-warn">{pendingJoinRequests} student{pendingJoinRequests === 1 ? ' is' : 's are'} waiting to join. <Link to="/class/requests" className="font-medium underline">Review requests</Link></p>
          )}
          {students.length === 0 ? <Empty title={dq ? 'No student matches that search' : 'No students yet'}>{dq ? 'Try a different name or roll number.' : 'Share your Class Key. Students appear here once you approve them.'}</Empty> : (
            <Card pad={false}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    <tr><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Student</th><th className="px-4 py-3 text-right">Score</th><th className="px-4 py-3 text-right">CGPA</th><th className="px-4 py-3 text-right">Attendance</th><th className="px-4 py-3 text-right">Backlogs</th><th className="px-4 py-3">Risk</th><th className="px-4 py-3" /></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {students.map((st) => (
                      <tr key={st.id} className="hover:bg-surface-2/60">
                        <td className="px-4 py-3 tabular-nums text-muted">{st.hasData ? st.rank : '—'}</td>
                        <td className="px-4 py-3"><Link to={`/class/students/${st.id}`} className="font-medium hover:text-brand">{st.name}</Link><div className="text-xs text-muted">{st.rollNumber || 'No roll number'}</div></td>
                        <td className="px-4 py-3 text-right tabular-nums">{num(st.score)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{num(st.cgpa, 2)}</td>
                        <td className={`px-4 py-3 text-right tabular-nums ${pctTone(st.attendancePct)}`}>{st.attendancePct != null ? `${num(st.attendancePct)}%` : '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{st.backlogs ?? '—'}</td>
                        <td className="px-4 py-3"><RiskPill band={st.risk.band} /></td>
                        <td className="px-4 py-3 text-right">{st.pendingItems > 0 && <Link to="/class/verification"><Pill tone="warn">{st.pendingItems} to verify</Pill></Link>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}</Async>
    </>
  );
}
