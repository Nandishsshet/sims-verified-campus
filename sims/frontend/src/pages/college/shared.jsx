import { Link } from 'react-router-dom';
import { Pill, Progress, num } from '../../ui';

/** The seven department-score components (docs/SCORING.md §8), in display order. */
export const METRICS = {
  avgSgpa: 'Average SGPA', attendance: 'Attendance', passPct: 'Pass rate', certificates: 'Certificates',
  placement: 'Placement readiness', skills: 'Verified skills', events: 'Event participation',
};
export const METRIC_KEYS = Object.keys(METRICS);

/** Raw metric (as returned in `metrics`) → [label, formatter]. Used by the metrics table. */
export const RAW = {
  avgSgpa: ['Avg SGPA', (v) => num(v, 2)],
  attendancePct: ['Attendance', (v) => `${num(v)}%`],
  passPct: ['No backlog', (v) => `${num(v)}%`],
  certsPerStudent: ['Certs / student', (v) => num(v, 2)],
  placementReadiness: ['Placement', (v) => `${num(v, 0)}%`],
  skillGapPct: ['Skill gap', (v) => `${num(v, 0)}%`],
  eventParticipationPct: ['Events', (v) => `${num(v, 0)}%`],
};

/** Round rank badge; groups without data have no rank. */
export const RankBadge = ({ rank }) => (
  <span className={`inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold ${rank && rank <= 3 ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-muted'}`}>{rank ?? '—'}</span>
);

/** A score, or an honest "no data yet" instead of a misleading 0. */
export const ScoreText = ({ score, className = '' }) => (score == null
  ? <span className={`text-sm text-muted ${className}`}>No data yet</span>
  : <b className={`tabular-nums ${className}`}>{num(score)}</b>);

/**
 * One bar per score component (0–100). `weak` components are flagged; with `college` set, each row also
 * shows the parent average (labelled `parentLabel`: "college" for a department, "university" for a college).
 */
export function ComponentBars({ components, weak = [], college, parentLabel = 'college' }) {
  if (!components) return <p className="text-sm text-muted">No verified data yet — scores appear once attendance or marks are verified.</p>;
  return (
    <ul className="space-y-3">
      {METRIC_KEYS.map((k) => (
        <li key={k}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">{METRICS[k]} {weak.includes(k) && <Pill tone="bad">Weak</Pill>}</span>
            <span className="tabular-nums text-muted">{num(components[k], 0)}{college ? <> · {parentLabel} {num(college[k], 0)}</> : null}</span>
          </div>
          <Progress value={components[k]} label={METRICS[k]} />
        </li>
      ))}
    </ul>
  );
}

const RISK_SEG = [['low', 'bg-good', 'Low'], ['medium', 'bg-warn', 'Medium'], ['high', 'bg-bad', 'High'], ['unknown', 'bg-surface-2', 'No data']];
/** Stacked bar of students by dropout-risk band, with a legend that carries the counts. */
export function RiskBar({ risk }) {
  const total = RISK_SEG.reduce((a, [k]) => a + (risk?.[k] || 0), 0);
  if (!total) return <p className="text-sm text-muted">No students yet.</p>;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={RISK_SEG.map(([k, , l]) => `${risk[k] || 0} ${l}`).join(', ')}>
        {RISK_SEG.map(([k, cls]) => (risk[k] ? <div key={k} className={cls} style={{ width: `${(100 * risk[k]) / total}%` }} /> : null))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {RISK_SEG.map(([k, cls, label]) => <li key={k} className="flex items-center gap-1.5"><span className={`size-2.5 rounded-full ${cls} ${k === 'unknown' ? 'border border-line' : ''}`} />{label} <b className="tabular-nums text-ink">{risk[k] || 0}</b></li>)}
      </ul>
    </div>
  );
}

const SEVERITY = { critical: ['bad', 'Critical'], warning: ['warn', 'Needs attention'], info: ['info', 'Info'], positive: ['good', 'Good news'] };
export const SeverityPill = ({ severity }) => { const [tone, text] = SEVERITY[severity] || SEVERITY.info; return <Pill tone={tone}>{text}</Pill>; };

/** Internal link used by insight lines (`to` comes from the API and is always a /college or /university path). */
export const InsightLink = ({ to, children }) => (to && /^\/(college|university)(\/|$|\?)/.test(to) ? <Link to={to} className="text-xs font-medium text-brand hover:underline">{children}</Link> : null);

/** Hours → "5 h" / "3.2 days" for instructor verification turnaround. */
export const fmtHours = (h) => (h == null ? '—' : h < 48 ? `${num(h, 1)} h` : `${num(h / 24, 1)} days`);
