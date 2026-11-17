import { useState } from 'react';
import { api } from '../../api';
import { Async, Button, Card, Empty, PageHeader, Select, fmtDateTime, useAction, useLoad } from '../../ui';
import { download } from '../class/shared';

const EXPORTS = [
  ['accreditation', 'Accreditation summary', 'Department and college totals: students, score, attendance, pass rate, certificates and placement readiness.'],
  ['departments', 'Departments', 'Rank, score and every metric for each department.'],
  ['classes', 'Classes', 'Each class with its department, instructor, score and verification queue.'],
  ['students', 'Students', 'The college-wide student leaderboard with score components.'],
  ['instructors', 'Instructors', 'Status, department, workload and verification turnaround.'],
];
const FILTERS = [['', 'All activity'], ['instructor', 'Instructor approvals'], ['department', 'Departments'], ['certificate', 'Certificate decisions'], ['project', 'Project decisions'], ['marks', 'Marks'], ['attendance', 'Attendance'], ['student', 'Students'], ['announcement', 'Announcements'], ['event', 'Events'], ['activity', 'Class activities'], ['leaderboard', 'Leaderboard weights'], ['report', 'Exports'], ['key', 'Keys']];

const pretty = (a) => a.replace(/[._]/g, ' ');
const detail = (m) => {
  if (!m || typeof m !== 'object') return '';
  return Object.entries(m).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(' · ');
};

export default function Reports() {
  const [run, busy] = useAction();
  const [action, setAction] = useState('');
  const [more, setMore] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const q = useLoad(() => { setMore([]); return api.get(`/college/audit-logs?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}`); }, [action]);

  const loadMore = async (before) => {
    setLoadingMore(true);
    try { const r = await api.get(`/college/audit-logs?limit=50&before=${before}${action ? `&action=${encodeURIComponent(action)}` : ''}`); setMore((m) => [...m, r]); } finally { setLoadingMore(false); }
  };

  return (
    <>
      <PageHeader title="Reports & audit" subtitle="Download verified data as CSV, and see everything that changed in the college." />
      <Card title="Export (CSV)" className="mb-6">
        <ul className="divide-y divide-line">
          {EXPORTS.map(([kind, title, text]) => (
            <li key={kind} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 basis-72 flex-1"><div className="text-sm font-medium">{title}</div><p className="text-xs text-muted">{text}</p></div>
              <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => download(`/college/export/${kind}`, `college-${kind}.csv`), `${title} exported`).then(() => q.reload(true))}>Download CSV</Button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">Exports contain verified data only. Each download is recorded in the audit log below.</p>
      </Card>

      <h2 className="mb-3 text-sm font-semibold tracking-tight">Audit log</h2>
      <div className="mb-4"><Select aria-label="Filter" className="!w-auto" value={action} onChange={(e) => setAction(e.target.value)}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
      <Async state={q}>{(first) => {
        const pages = [first, ...more];
        const logs = pages.flatMap((p) => p.logs);
        const next = pages[pages.length - 1].nextBefore;
        return logs.length === 0 ? <Empty title="Nothing recorded yet" /> : (
          <Card pad={false}>
            <ul className="divide-y divide-line">{logs.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
                <div className="min-w-0"><span className="font-medium capitalize">{pretty(l.action)}</span> <span className="text-muted">by {l.actor || 'system'}{l.actorRole ? ` (${l.actorRole.replace('_', ' ')})` : ''}{l.class ? ` · ${l.class}` : ''}</span>
                  {detail(l.metadata) && <div className="truncate text-xs text-muted">{detail(l.metadata)}</div>}</div>
                <time className="shrink-0 text-xs text-muted" dateTime={l.at}>{fmtDateTime(l.at)}</time>
              </li>
            ))}</ul>
            {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" busy={loadingMore} onClick={() => loadMore(next)}>Load older entries</Button></div>}
          </Card>
        );
      }}</Async>
    </>
  );
}
