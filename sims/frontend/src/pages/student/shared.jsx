import { useState } from 'react';
import { api } from '../../api';
import { Icon } from '../../icons';
import { Select, useLoad } from '../../ui';

const LEVELS = ['', 'Aware', 'Basic', 'Working', 'Proficient', 'Expert'];

/** Choose skills (from the catalogue) that a certificate / project evidences. value = [{skillId, proficiency}] */
export function SkillPicker({ value, onChange, max = 10 }) {
  const cat = useLoad(() => api.get('/skills'));
  const [pick, setPick] = useState('');
  const skills = cat.data?.skills || [];
  const name = (id) => skills.find((s) => s.id === id)?.name || '…';
  const free = skills.filter((s) => !value.some((v) => v.skillId === s.id));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="space-y-1.5">{value.map((v, i) => (
          <li key={v.skillId} className="flex items-center gap-2 rounded-xl border border-line px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{name(v.skillId)}</span>
            <select aria-label={`Level for ${name(v.skillId)}`} value={v.proficiency} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, proficiency: Number(e.target.value) } : x)))}
              className="rounded-lg border border-line bg-surface px-2 py-1 text-xs">{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {LEVELS[n]}</option>)}</select>
            <button type="button" onClick={() => onChange(value.filter((_, k) => k !== i))} className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-bad" aria-label={`Remove ${name(v.skillId)}`}><Icon name="x" className="size-4" /></button>
          </li>
        ))}</ul>
      )}
      {value.length < max && (
        <Select value={pick} onChange={(e) => { if (e.target.value) { onChange([...value, { skillId: e.target.value, proficiency: 3 }]); setPick(''); } }} aria-label="Add a skill">
          <option value="">+ Add a skill this evidences…</option>
          {free.map((s) => <option key={s.id} value={s.id}>{s.name}{s.category ? ` — ${s.category}` : ''}</option>)}
        </Select>
      )}
    </div>
  );
}

export const LEVEL_NAMES = LEVELS;
