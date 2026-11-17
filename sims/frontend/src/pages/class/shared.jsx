import { api } from '../../api';
import { Pill } from '../../ui';

/** Underlined tab strip. tabs = [{ id, label, badge? }] */
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={`-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition ${value === t.id ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink'}`}>
          {t.label}{t.badge ? <span className="ml-1.5 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

const RISK = { low: ['good', 'Low risk'], medium: ['warn', 'Medium risk'], high: ['bad', 'High risk'], unknown: ['muted', 'No data yet'] };
export const RiskPill = ({ band }) => { const [tone, text] = RISK[band] || RISK.unknown; return <Pill tone={tone}>{text}</Pill>; };

/** Colour a percentage: attendance/score style thresholds. */
export const pctTone = (v, good = 75, warn = 60) => (v == null ? 'text-muted' : v >= good ? 'text-good' : v >= warn ? 'text-warn' : 'text-bad');

/** Save a Blob the API returned (CSV exports, templates). */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export const download = async (path, filename) => saveBlob(await api.get(path), filename);

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const TYPE_LABEL = { profile: 'Profile', marks: 'Marks', attendance: 'Attendance', certificate: 'Certificates', project: 'Projects', skill: 'Skills' };

/** Per-type fields to show when reviewing an item. [key in the API row, label, formatter?] */
export const ITEM_FIELDS = {
  certificate: [['title', 'Title'], ['issuer', 'Issuer'], ['category', 'Category'], ['issue_date', 'Issue date'], ['credential_url', 'Credential link']],
  project: [['title', 'Title'], ['type', 'Type'], ['organization', 'Organisation'], ['role', 'Role'], ['description', 'Description'], ['bullets', 'Resume bullets'], ['tech_stack', 'Tech stack'], ['url', 'Link'], ['start_date', 'Start'], ['end_date', 'End']],
  marks: [['attempt', 'Attempt'], ['internal_obtained', 'Internal obtained'], ['internal_max', 'Internal max'], ['external_obtained', 'External obtained'], ['external_max', 'External max'], ['grade', 'Grade']],
  attendance: [['attendance_date', 'Date'], ['period', 'Period'], ['status', 'Claimed as'], ['claim_note', 'Student’s note']],
  profile: [['date_of_birth', 'Date of birth'], ['gender', 'Gender'], ['address', 'Address'], ['guardian_name', 'Guardian'], ['guardian_email', 'Guardian e-mail'], ['guardian_phone', 'Guardian phone'], ['summary', 'Summary'], ['linkedin_url', 'LinkedIn'], ['github_url', 'GitHub']],
  skill: [['proficiency', 'Claimed level (1–5)'], ['source', 'Source']],
};
