import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async, Card, Empty, PageHeader, Pill, Stat, StatusChip, fmtDate, useLoad } from '../../ui';

const TYPE = { profile: 'Profile', certificate: 'Certificate', project: 'Project', internship: 'Internship', publication: 'Publication', marks: 'Marks', attendance: 'Attendance' };

export default function Verification() {
  const s = useLoad(() => api.get('/student/verification-status'));
  return (
    <>
      <PageHeader title="Verification status" subtitle="Everything you submitted and where it stands. Only verified items count in your resume, skills, ranking and analytics." />
      <Async state={s}>{({ items }) => {
        const n = (st) => items.filter((i) => i.status === st).length;
        const fix = items.filter((i) => i.status === 'rejected' || i.status === 'correction_requested');
        return items.length === 0 ? <Empty title="Nothing submitted yet">Upload a certificate or add a project to get started.</Empty> : (<>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Verified" value={n('verified')} tone="good" /><Stat label="Pending" value={n('pending')} tone="warn" />
            <Stat label="Needs correction" value={n('correction_requested')} /><Stat label="Rejected" value={n('rejected')} tone={n('rejected') ? 'bad' : 'default'} />
          </div>
          {fix.length > 0 && (
            <div className="mt-6 rounded-2xl border border-bad/30 bg-bad-soft p-5">
              <h2 className="font-semibold text-bad">Needs your attention</h2>
              <ul className="mt-3 space-y-2">{fix.map((i) => (
                <li key={`${i.type}-${i.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-4 py-3 text-sm">
                  <div className="min-w-0"><b>{i.label}</b><p className="text-muted">{i.remarks || 'Your instructor asked for a change.'}</p></div>
                  <Link to={i.link} className="font-medium text-brand hover:underline">Fix it</Link>
                </li>
              ))}</ul>
            </div>
          )}
          <Card className="mt-6" pad={false}>
            <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm"><thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="px-5 py-3">Item</th><th>Type</th><th>Status</th><th className="pr-5">Updated</th></tr></thead>
              <tbody className="divide-y divide-line">{items.map((i) => (
                <tr key={`${i.type}-${i.id}`}><td className="px-5 py-3 font-medium"><Link to={i.link} className="hover:text-brand hover:underline">{i.label}</Link></td><td><Pill>{TYPE[i.type] || i.type}</Pill></td><td><StatusChip status={i.status} /></td><td className="pr-5 text-muted">{fmtDate(i.verifiedAt || i.updatedAt)}</td></tr>
              ))}</tbody></table></div>
          </Card>
        </>);
      }}</Async>
    </>
  );
}
