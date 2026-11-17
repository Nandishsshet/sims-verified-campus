import { useState } from 'react';
import { api } from '../../api';
import { Async, Button, Card, Empty, PageHeader, Select, fmtDateTime, useAction, useLoad } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { download } from './shared';

const FILTERS = [['', 'All activity'], ['certificate', 'Certificate decisions'], ['project', 'Project decisions'], ['marks', 'Marks'], ['attendance', 'Attendance'], ['student', 'Students'], ['leaderboard', 'Leaderboard'], ['report', 'Exports'], ['key', 'Class Key']];
const EXPORTS = [['students', 'Students'], ['leaderboard', 'Leaderboard'], ['attendance', 'Attendance'], ['marks', 'Marks']];

const pretty = (a) => a.replace(/[._]/g, ' ');
/** One short line of context from the audit metadata. */
const detail = (m) => {
  if (!m || typeof m !== 'object') return '';
  return Object.entries(m).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(' · ');
};

export default function Audit() {
  const { url, current } = useClass();
  const [run, busy] = useAction();
  const [action, setAction] = useState('');
  const [more, setMore] = useState([]);                 // older pages appended by "Load more"
  const [loadingMore, setLoadingMore] = useState(false);
  const q = useLoad(() => { setMore([]); return api.get(url(`/audit-logs?limit=50${action ? `&action=${action}` : ''}`)); }, [current.id, action]);

  const loadMore = async (before) => {
    setLoadingMore(true);
    try { const r = await api.get(url(`/audit-logs?limit=50&before=${before}${action ? `&action=${action}` : ''}`)); setMore((m) => [...m, r]); } finally { setLoadingMore(false); }
  };

  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Audit log" subtitle="Every verification decision and data change in this class is recorded here." />
      <Card title="Export data" className="mb-6">
        <div className="flex flex-wrap gap-2">{EXPORTS.map(([k, label]) => <Button key={k} variant="secondary" size="sm" busy={busy} onClick={() => run(() => download(url(`/export/${k}`), `class-${k}.csv`), `${label} exported`).then(() => q.reload(true))}>{label} CSV</Button>)}</div>
        <p className="mt-2 text-xs text-muted">Exports contain verified data only. Each export is logged below.</p>
      </Card>

      <div className="mb-4"><Select aria-label="Filter" className="!w-auto" value={action} onChange={(e) => setAction(e.target.value)}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
      <Async state={q}>{(first) => {
        const pages = [first, ...more];
        const logs = pages.flatMap((p) => p.logs);
        const next = pages[pages.length - 1].nextBefore;
        return logs.length === 0 ? <Empty title="Nothing recorded yet" /> : (
          <Card pad={false}>
            <ul className="divide-y divide-line">{logs.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
                <div className="min-w-0"><span className="font-medium capitalize">{pretty(l.action)}</span> <span className="text-muted">by {l.actor || 'system'}{l.actorRole ? ` (${l.actorRole.replace('_', ' ')})` : ''}</span>
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
