import { Pill } from '../../ui';

/** College lifecycle: pending → active ⇄ suspended (docs/API.md §3). */
const STATUS = { active: ['good', 'Active'], pending: ['warn', 'Pending approval'], suspended: ['bad', 'Suspended'] };
export const StatusPill = ({ status }) => { const [tone, text] = STATUS[status] || ['muted', status]; return <Pill tone={tone}>{text}</Pill>; };

/**
 * Heat-map cell tint for a 0–100 component: green when healthy, red when weak (< 60, the same threshold as
 * the “Weak” flag everywhere else). Intensity grows with the distance from the threshold; colour is never
 * the only signal because the number is always printed in the cell.
 */
export function heatStyle(value) {
  if (value == null) return undefined;
  const weak = value < 60;
  const strength = weak ? (60 - value) / 60 : (value - 60) / 40;
  const pct = Math.round(10 + Math.min(1, Math.max(0, strength)) * 30);
  return { background: `color-mix(in srgb, var(${weak ? '--bad' : '--good'}) ${pct}%, transparent)` };
}
