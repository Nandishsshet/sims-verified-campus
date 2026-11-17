import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { Icon } from '../../icons';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Progress, Select, Spinner, Textarea, useAction, useLoad, useToast } from '../../ui';

const SECTION_LABEL = { summary: 'Summary', education: 'Education', skills: 'Skills', projects: 'Projects', experience: 'Experience', publications: 'Publications', certificates: 'Certificates', achievements: 'Achievements' };
const ITEM_SECTIONS = ['projects', 'experience', 'publications', 'certificates', 'achievements'];
const A4 = { w: 794, h: 1123 };                    // px at 96 dpi

/** Same rules as the server's mergeContent(): lets the preview react instantly while typing. */
function mergeLocal(base, content = {}) {
  const hidden = new Set(content.hidden || []);
  const keep = (l) => l.filter((x) => !hidden.has(x.id));
  const reword = (l) => keep(l).map((x) => (Array.isArray(content.bullets?.[x.id]) ? { ...x, bullets: content.bullets[x.id] } : x));
  const have = new Set(base.skills.map((s) => s.name.toLowerCase()));
  const extra = (content.extraSkills || []).filter((n) => !have.has(n.toLowerCase())).map((name) => ({ name, level: null, extra: true }));
  return {
    ...base,
    personal: { ...base.personal, ...Object.fromEntries(Object.entries(content.contact || {}).filter(([, v]) => v)) },
    summary: content.summary ?? base.summary,
    skills: [...base.skills, ...extra],
    projects: reword(base.projects), experience: reword(base.experience),
    publications: keep(base.publications), certificates: keep(base.certificates), achievements: keep(base.achievements),
  };
}

/* ======================================================================== preview */
const yr = (d) => (d ? String(d).slice(0, 7) : '');
const range = (a, b) => [yr(a), yr(b) || (a ? 'Present' : '')].filter(Boolean).join(' – ');
const bare = (u) => (u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

const THEMES = {
  classic: { root: 'font-serif text-[13px] leading-[1.35]', name: 'text-[26px] font-bold text-center tracking-wide', contact: 'text-center text-[12px]', h: 'mt-3.5 mb-1.5 border-b border-neutral-800 text-[13px] font-bold uppercase tracking-[0.12em]', pad: 'px-12 py-10' },
  compact: { root: 'font-sans text-[12px] leading-[1.28]', name: 'text-[22px] font-bold', contact: 'text-[11.5px] text-neutral-600', h: 'mt-2.5 mb-1 border-b border-neutral-300 text-[12px] font-bold uppercase tracking-wide text-neutral-800', pad: 'px-9 py-7' },
  academic: { root: 'font-serif text-[13px] leading-[1.4]', name: 'text-[24px] font-semibold', contact: 'text-[12px] text-neutral-600', h: 'mt-4 mb-1.5 text-[14px] font-semibold italic border-b border-neutral-400 pb-0.5', pad: 'px-12 py-10' },
  minimal: { root: 'font-sans text-[12.5px] leading-[1.5] text-neutral-800', name: 'text-[28px] font-light tracking-tight', contact: 'text-[12px] text-neutral-500', h: 'mt-5 mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-neutral-500', pad: 'px-14 py-12' },
  modern: { root: 'font-sans text-[12.5px] leading-[1.4]', name: 'text-[26px] font-bold', contact: '', h: 'mt-4 mb-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-indigo-700', pad: '' },
};

function Section({ k, data, t }) {
  const H = ({ children }) => <h3 className={t.h}>{children}</h3>;
  const Bul = ({ list }) => list?.length ? <ul className="ml-4 mt-0.5 list-disc space-y-0.5">{list.map((b, i) => <li key={i}>{b}</li>)}</ul> : null;
  switch (k) {
    case 'summary': return data.summary ? <><H>Summary</H><p>{data.summary}</p></> : null;
    case 'education': return data.education.length ? <><H>Education</H>{data.education.map((e) => (
      <div key={e.id} className="flex justify-between gap-4"><div><b>{e.degree}</b>{e.institution ? `, ${e.institution}` : ''}{e.university ? <span className="text-neutral-500"> · {e.university}</span> : null}</div><div className="shrink-0 text-right">{e.start}–{e.end}{e.cgpa ? ` · CGPA ${Number(e.cgpa).toFixed(2)}` : ''}</div></div>))}</> : null;
    case 'skills': return data.skills.length ? <><H>Skills</H><p>{data.skills.map((s) => s.name).join(' · ')}</p></> : null;
    case 'projects': return data.projects.length ? <><H>Projects</H>{data.projects.map((p) => (
      <div key={p.id} className="mb-1.5"><div className="flex justify-between gap-4"><div><b>{p.title}</b>{p.tech?.length ? <span className="text-neutral-500"> | {p.tech.join(', ')}</span> : null}</div><div className="shrink-0">{range(p.start, p.end)}</div></div><Bul list={p.bullets} /></div>))}</> : null;
    case 'experience': return data.experience.length ? <><H>Experience</H>{data.experience.map((p) => (
      <div key={p.id} className="mb-1.5"><div className="flex justify-between gap-4"><div><b>{p.title}</b>{p.organization ? `, ${p.organization}` : ''}</div><div className="shrink-0">{range(p.start, p.end)}</div></div><Bul list={p.bullets} /></div>))}</> : null;
    case 'publications': return data.publications.length ? <><H>Publications</H>{data.publications.map((p) => <p key={p.id}><b>{p.title}</b>{p.organization ? `, ${p.organization}` : ''}{p.date ? ` (${yr(p.date)})` : ''}</p>)}</> : null;
    case 'certificates': return data.certificates.length ? <><H>Certifications</H><ul className="ml-4 list-disc space-y-0.5">{data.certificates.map((c) => <li key={c.id}>{c.title} — {c.issuer}{c.date ? ` (${yr(c.date)})` : ''}</li>)}</ul></> : null;
    case 'achievements': return data.achievements.length ? <><H>Achievements</H><ul className="ml-4 list-disc space-y-0.5">{data.achievements.map((a) => <li key={a.id}>{a.title} — {a.detail}</li>)}</ul></> : null;
    default: return null;
  }
}

function Sheet({ data, order, template }) {
  const t = THEMES[template] || THEMES.classic;
  const p = data.personal;
  const contact = [p.email, p.phone, p.location, bare(p.linkedin), bare(p.github)].filter(Boolean);
  if (template === 'modern') {
    const side = ['skills', 'certificates', 'achievements'];
    return (
      <div className={`flex min-h-full text-neutral-900 ${t.root}`}>
        <aside className="w-[34%] shrink-0 bg-indigo-950 px-7 py-10 text-indigo-50">
          <h1 className={`${t.name} leading-tight`}>{p.name}</h1>
          <div className="mt-4 space-y-1 break-words text-[11.5px] text-indigo-200">{contact.map((c) => <div key={c}>{c}</div>)}</div>
          {order.filter((k) => side.includes(k)).map((k) => {
            if (k === 'skills' && data.skills.length) return <div key={k}><h3 className="mt-6 mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-indigo-300">Skills</h3><div className="flex flex-wrap gap-1.5">{data.skills.map((s) => <span key={s.name} className="rounded bg-white/10 px-2 py-0.5 text-[11px]">{s.name}</span>)}</div></div>;
            if (k === 'certificates' && data.certificates.length) return <div key={k}><h3 className="mt-6 mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-indigo-300">Certifications</h3><ul className="space-y-1.5 text-[11.5px]">{data.certificates.map((c) => <li key={c.id}>{c.title}<div className="text-indigo-300">{c.issuer}</div></li>)}</ul></div>;
            if (k === 'achievements' && data.achievements.length) return <div key={k}><h3 className="mt-6 mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-indigo-300">Achievements</h3><ul className="space-y-1 text-[11.5px]">{data.achievements.map((a) => <li key={a.id}>{a.title} <span className="text-indigo-300">— {a.detail}</span></li>)}</ul></div>;
            return null;
          })}
        </aside>
        <div className="flex-1 px-8 py-10">{order.filter((k) => !side.includes(k)).map((k) => <Section key={k} k={k} data={data} t={t} />)}</div>
      </div>
    );
  }
  return (
    <div className={`min-h-full text-neutral-900 ${t.root} ${t.pad}`}>
      <h1 className={t.name}>{p.name}</h1>
      <p className={t.contact}>{contact.join('  •  ')}</p>
      {order.map((k) => <Section key={k} k={k} data={data} t={t} />)}
    </div>
  );
}

/**
 * A4 sheet scaled to fit. fit='page' also fits the viewport height (so a sticky preview is fully visible
 * on wide screens); fit='width' uses the column width. Printing resets the scale via CSS (see index.css).
 */
function Preview({ data, order, template, fit }) {
  const wrap = useRef(null);
  const [scale, setScale] = useState(0.6);
  useEffect(() => {
    const el = wrap.current; if (!el) return undefined;
    const calc = () => {
      const byWidth = el.clientWidth / A4.w;
      const byHeight = fit === 'page' && window.innerWidth >= 1280 ? (window.innerHeight - 190) / A4.h : Infinity;
      setScale(Math.max(0.3, Math.min(1, byWidth, byHeight)));
    };
    calc();
    const ro = new ResizeObserver(calc); ro.observe(el);
    window.addEventListener('resize', calc);
    return () => { ro.disconnect(); window.removeEventListener('resize', calc); };
  }, [fit]);
  return (
    <div ref={wrap} className="resume-wrap relative w-full overflow-hidden rounded-xl border border-line bg-neutral-200 dark:bg-neutral-800" style={{ height: A4.h * scale }}>
      <div id="resume-sheet" className="absolute top-0 bg-white shadow-lg" style={{ width: A4.w, minHeight: A4.h, left: '50%', marginLeft: -A4.w / 2, transformOrigin: 'top center', transform: `scale(${scale})` }}>
        <Sheet data={data} order={order} template={template} />
      </div>
    </div>
  );
}

/* ======================================================================== ATS */
function Gauge({ score }) {
  const r = 42; const c = 2 * Math.PI * r;
  const color = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--warn)' : 'var(--bad)';
  return (
    <svg viewBox="0 0 100 100" className="size-28 shrink-0" role="img" aria-label={`ATS score ${score} out of 100`}>
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--line)" strokeWidth="9" />
      <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 50 50)" style={{ transition: 'stroke-dasharray .5s' }} />
      <text x="50" y="49" textAnchor="middle" className="fill-[var(--ink)] text-[24px] font-semibold">{score}</text>
      <text x="50" y="65" textAnchor="middle" className="fill-[var(--muted)] text-[9px]">of 100</text>
    </svg>
  );
}

function AtsPanel({ ats, saving }) {
  if (!ats) return null;
  return (
    <Card title="ATS score" action={saving ? <span className="text-xs text-muted">updating…</span> : null}>
      <div className="flex items-center gap-5"><Gauge score={ats.score} /><p className="text-sm text-muted">How well automated recruiting systems can read and rank this resume. Calculated from your <b className="text-ink">verified</b> data and your target role's keywords.</p></div>
      <ul className="mt-4 space-y-3">{ats.breakdown.map((b) => (
        <li key={b.key}><div className="mb-1 flex justify-between text-xs"><span className="font-medium">{b.label}</span><span className="tabular-nums text-muted">{b.points}/{b.max}</span></div><Progress value={(b.points / b.max) * 100} label={b.label} />{b.points < b.max && b.tip && <p className="mt-1 text-xs text-muted">{b.tip}</p>}</li>
      ))}</ul>
      {ats.suggestions?.length > 0 && <div className="mt-4 rounded-xl bg-surface-2 p-3"><p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Top fixes</p><ul className="list-inside list-disc space-y-1 text-sm">{ats.suggestions.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
    </Card>
  );
}

/* ======================================================================== AI assistant */
function AiModal({ state, onClose, onApply }) {
  return (
    <Modal open={Boolean(state)} onClose={onClose} title="Writing assistant" wide>
      {state?.loading && <Spinner label="Reviewing" />}
      {state?.result && (
        <div className="space-y-4 text-sm">
          {state.result.original && <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Your text</p><p className="rounded-xl bg-surface-2 px-3 py-2">{state.result.original}</p></div>}
          {state.result.issues?.length > 0 ? <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">What to improve</p><ul className="space-y-1.5">{state.result.issues.map((i) => <li key={i.code} className="flex gap-2"><Pill tone="warn">fix</Pill><span>{i.message}</span></li>)}</ul></div> : <p className="text-good">Looks good — no issues found.</p>}
          {state.result.suggestions?.length > 0 && <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Suggested wording {state.result.source?.includes('llm') && <Pill tone="brand">AI</Pill>}</p>
            <ul className="space-y-2">{state.result.suggestions.map((s, i) => <li key={i} className="flex items-start justify-between gap-3 rounded-xl border border-line p-3"><span>{s}</span><Button size="sm" variant="secondary" onClick={() => onApply(s)}>Use</Button></li>)}</ul>
            <p className="mt-2 text-xs text-muted">Drafts use only facts from your verified record — replace any [placeholders] with your real numbers.</p></div>}
        </div>
      )}
    </Modal>
  );
}

/* ======================================================================== editor */
function ReorderList({ order, onChange }) {
  const [drag, setDrag] = useState(null);
  const move = (from, to) => { if (to < 0 || to >= order.length || from === to) return; const n = [...order]; const [x] = n.splice(from, 1); n.splice(to, 0, x); onChange(n); };
  const absent = Object.keys(SECTION_LABEL).filter((k) => !order.includes(k));
  return (
    <div>
      <ul className="space-y-1.5">{order.map((k, i) => (
        <li key={k} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { move(drag, i); setDrag(null); }}
          className={`flex cursor-grab items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-sm active:cursor-grabbing ${drag === i ? 'opacity-40' : ''}`}>
          <Icon name="grip" className="size-4 text-muted" /><span className="flex-1 font-medium">{SECTION_LABEL[k]}</span>
          <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30" aria-label={`Move ${SECTION_LABEL[k]} up`}><Icon name="up" className="size-4" /></button>
          <button type="button" onClick={() => move(i, i + 1)} disabled={i === order.length - 1} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30" aria-label={`Move ${SECTION_LABEL[k]} down`}><Icon name="down" className="size-4" /></button>
          <button type="button" onClick={() => order.length > 1 && onChange(order.filter((x) => x !== k))} disabled={order.length === 1} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-bad disabled:opacity-30" aria-label={`Remove ${SECTION_LABEL[k]}`}><Icon name="x" className="size-4" /></button>
        </li>
      ))}</ul>
      {absent.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{absent.map((k) => <button key={k} type="button" onClick={() => onChange([...order, k])} className="rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-brand">+ {SECTION_LABEL[k]}</button>)}</div>}
    </div>
  );
}

function Editor({ id, onDeleted, onRenamed }) {
  const toast = useToast();
  const roles = useLoad(() => api.get('/career-roles'));
  const tpl = useLoad(() => api.get('/student/resumes/templates'));
  const q = useLoad(() => api.get(`/student/resumes/${id}`), [id]);
  const [draft, setDraft] = useState(null);
  const [ats, setAts] = useState(null);
  const [saving, setSaving] = useState('idle');           // idle | dirty | saving | error
  const [ai, setAi] = useState(null);
  const [fit, setFit] = useState('page');
  const timer = useRef(null);
  const latest = useRef(null);

  useEffect(() => {
    if (!q.data) return;
    const r = q.data.resume;
    setDraft({ title: r.title, templateKey: r.templateKey, targetRoleId: r.targetRoleId, sectionOrder: r.sectionOrder, content: r.content || {} });
    setAts(q.data.ats); setSaving('idle');
  // only (re)initialise when a different resume is loaded
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.resume.id]);

  const flush = useCallback(async () => {
    const d = latest.current; if (!d) return;
    setSaving('saving');
    try {
      const c = d.content;
      const clean = {
        ...c,
        ...(c.contact ? { contact: Object.fromEntries(Object.entries(c.contact).map(([k, v]) => [k, v ? v : null])) } : {}),
        ...(c.bullets ? { bullets: Object.fromEntries(Object.entries(c.bullets).map(([k, v]) => [k, v.map((x) => x.trim()).filter((x) => x.length >= 3)])) } : {}),
      };
      const res = await api.put(`/student/resumes/${id}`, { title: d.title, templateKey: d.templateKey, targetRoleId: d.targetRoleId, sectionOrder: d.sectionOrder, content: clean });
      setAts(res.ats); setSaving('idle'); onRenamed?.(id, d.title);
    } catch (e) { setSaving('error'); toast(`Not saved: ${e.message}`, 'error'); }
  }, [id, onRenamed, toast]);

  const update = (patch) => {
    setDraft((p) => { const n = { ...p, ...patch }; latest.current = n; return n; });
    setSaving('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1000);
  };
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const setContent = (patch) => update({ content: { ...draft.content, ...patch } });

  const merged = useMemo(() => (q.data && draft ? mergeLocal(q.data.base, draft.content) : null), [q.data, draft]);
  if (q.loading && !q.data) return <Spinner />;
  if (!q.data || !draft) return null;
  const c = draft.content;
  const hidden = new Set(c.hidden || []);
  const toggleHidden = (itemId) => setContent({ hidden: hidden.has(itemId) ? [...hidden].filter((x) => x !== itemId) : [...hidden, itemId] });
  const setBullets = (item, list) => setContent({ bullets: { ...(c.bullets || {}), [item.id]: list } });
  const bulletsOf = (item) => c.bullets?.[item.id] ?? item.bullets ?? [];

  const askAi = async (section, text, onApply) => {
    setAi({ loading: true, onApply });
    try { setAi({ result: await api.post(`/student/resumes/${id}/ai/improve`, { section, text }), onApply }); }
    catch (e) { setAi(null); toast(e.message, 'error'); }
  };
  const remove = async () => { if (confirm('Delete this resume?')) { await api.del(`/student/resumes/${id}`); onDeleted(); } };
  const base = q.data.base;
  const itemsOf = (k) => (k === 'certificates' ? base.certificates : k === 'achievements' ? base.achievements : base[k]);
  const status = { idle: 'Saved', dirty: 'Unsaved changes…', saving: 'Saving…', error: 'Not saved' }[saving];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input aria-label="Resume title" className="!w-64 font-medium" value={draft.title} onChange={(e) => update({ title: e.target.value })} maxLength={80} />
        <span className={`text-xs ${saving === 'error' ? 'text-bad' : 'text-muted'}`} aria-live="polite">{status}</span>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={async () => { clearTimeout(timer.current); await flush(); window.print(); }}><Icon name="download" className="size-4" />Download PDF</Button>
          <Button variant="ghost" onClick={remove} aria-label="Delete resume"><Icon name="trash" className="size-4 text-bad" /></Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_1fr]">
        <div className="space-y-4 xl:order-first">
          <AtsPanel ats={ats} saving={saving === 'saving'} />
          <Card title="Template">
            <div className="grid grid-cols-1 gap-2">{(tpl.data?.templates || []).map((t) => (
              <button key={t.key} type="button" onClick={() => update({ templateKey: t.key })} aria-pressed={draft.templateKey === t.key}
                className={`rounded-xl border px-3 py-2 text-left transition ${draft.templateKey === t.key ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-2'}`}>
                <span className="flex items-center justify-between text-sm font-medium">{t.name}{t.atsSafe ? <Pill tone="good">ATS-safe</Pill> : <Pill tone="warn">Less ATS-friendly</Pill>}</span>
                <span className="mt-0.5 block text-xs text-muted">{t.description}</span>
              </button>
            ))}</div>
          </Card>

          <Card title="Target role">
            <Select value={draft.targetRoleId || ''} onChange={(e) => update({ targetRoleId: e.target.value || null })} aria-label="Target role">
              <option value="">None — generic keywords</option>{(roles.data?.roles || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <p className="mt-1.5 text-xs text-muted">The ATS score checks your resume against this role's skills.</p>
          </Card>

          <Card title="Sections — drag to reorder"><ReorderList order={draft.sectionOrder} onChange={(o) => update({ sectionOrder: o })} /></Card>

          <Card title="Summary" action={<Button size="sm" variant="secondary" onClick={() => askAi('summary', merged.summary || '', (s) => setContent({ summary: s }))}><Icon name="spark" className="size-3.5" />Improve</Button>}>
            <Textarea rows={5} maxLength={800} value={c.summary ?? base.summary} onChange={(e) => setContent({ summary: e.target.value })} placeholder="2–3 lines: who you are, your strongest skills, the role you want." />
            <p className="mt-1 text-xs text-muted">{(c.summary ?? base.summary).trim().split(/\s+/).filter(Boolean).length} words · aim for 35–70</p>
          </Card>

          <Card title="Contact details">
            <div className="grid gap-3">{[['location', 'Location'], ['phone', 'Phone'], ['linkedin', 'LinkedIn URL'], ['github', 'GitHub URL']].map(([k, label]) => (
              <Field key={k} label={label}><Input value={c.contact?.[k] ?? base.personal[k] ?? ''} onChange={(e) => setContent({ contact: { ...(c.contact || {}), [k]: e.target.value } })} placeholder={k === 'linkedin' || k === 'github' ? 'https://…' : ''} /></Field>
            ))}</div>
          </Card>

          <Card title="Skills">
            <p className="mb-2 text-xs text-muted">Verified skills are added automatically. Add more below (they're listed but not marked verified).</p>
            <div className="mb-2 flex flex-wrap gap-1.5">{base.skills.map((s) => <Pill key={s.name} tone="good">✓ {s.name}</Pill>)}{(c.extraSkills || []).map((s) => <button key={s} type="button" onClick={() => setContent({ extraSkills: c.extraSkills.filter((x) => x !== s) })} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs hover:bg-bad-soft hover:text-bad" title="Remove">{s} ✕</button>)}</div>
            <Input placeholder="Type a skill and press Enter" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value.trim(); if (v && !(c.extraSkills || []).includes(v)) setContent({ extraSkills: [...(c.extraSkills || []), v] }); e.currentTarget.value = ''; } }} />
          </Card>

          {ITEM_SECTIONS.filter((k) => itemsOf(k).length > 0).map((k) => (
            <Card key={k} title={SECTION_LABEL[k]}>
              <ul className="space-y-4">{itemsOf(k).map((it) => (
                <li key={it.id} className={hidden.has(it.id) ? 'opacity-50' : ''}>
                  <div className="flex items-start justify-between gap-2"><p className="text-sm font-medium">{it.title}</p><button type="button" onClick={() => toggleHidden(it.id)} className="shrink-0 text-xs font-medium text-brand hover:underline">{hidden.has(it.id) ? 'Show' : 'Hide'}</button></div>
                  {(k === 'projects' || k === 'experience') && !hidden.has(it.id) && (
                    <div className="mt-2 space-y-1.5">
                      {bulletsOf(it).map((b, i) => (
                        <div key={i} className="flex gap-1.5">
                          <Input value={b} aria-label={`Bullet ${i + 1} of ${it.title}`} onChange={(e) => setBullets(it, bulletsOf(it).map((x, j) => (j === i ? e.target.value : x)))} />
                          <button type="button" title="Improve wording" aria-label="Improve this bullet" onClick={() => askAi('bullet', b, (s) => setBullets(it, bulletsOf(it).map((x, j) => (j === i ? s : x))))} className="rounded-xl border border-line px-2 text-brand hover:bg-brand-soft"><Icon name="spark" className="size-4" /></button>
                          <button type="button" aria-label="Remove bullet" onClick={() => setBullets(it, bulletsOf(it).filter((_, j) => j !== i))} className="rounded-xl border border-line px-2 text-muted hover:text-bad"><Icon name="x" className="size-4" /></button>
                        </div>
                      ))}
                      {bulletsOf(it).length < 8 && <button type="button" onClick={() => setBullets(it, [...bulletsOf(it), ''])} className="text-xs font-medium text-brand hover:underline">+ Add bullet</button>}
                    </div>
                  )}
                </li>
              ))}</ul>
            </Card>
          ))}
        </div>

        <div className={`min-w-0 space-y-3 max-xl:-order-1 ${fit === 'page' ? 'xl:sticky xl:top-20 xl:self-start' : ''}`}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Live preview</span>
            <div className="inline-flex rounded-xl border border-line p-0.5 text-xs" role="group" aria-label="Preview size">
              {[['page', 'Fit page'], ['width', 'Fit width']].map(([k, label]) => <button key={k} type="button" aria-pressed={fit === k} onClick={() => setFit(k)} className={`rounded-lg px-2.5 py-1 font-medium ${fit === k ? 'bg-brand-soft text-brand' : 'text-muted'}`}>{label}</button>)}
            </div>
          </div>
          <Preview data={merged} order={draft.sectionOrder} template={draft.templateKey} fit={fit} />
          <p className="text-xs text-muted">The preview is what “Download PDF” prints — choose <b>Save as PDF</b> in the print dialog and turn off “Headers and footers”.</p>
        </div>
      </div>
      <AiModal state={ai} onClose={() => setAi(null)} onApply={(s) => { ai.onApply(s); setAi(null); }} />
    </>
  );
}

/* ======================================================================== page */
export default function Resume() {
  const list = useLoad(() => api.get('/student/resumes'));
  const [sel, setSel] = useState(null);
  const [run, busy] = useAction();
  const resumes = list.data?.resumes || [];
  useEffect(() => { if (!sel && resumes.length) setSel(resumes[0].id); }, [resumes, sel]);

  const create = () => run(async () => { const r = await api.post('/student/resumes', { title: `Resume ${resumes.length + 1}` }); await list.reload(true); setSel(r.resume.id); }, 'Resume created from your verified data');

  return (
    <>
      <PageHeader title="Resume Builder" subtitle="Built automatically from your verified records. Edit the wording, pick a template, check the ATS score, download a PDF."
        action={<div className="flex gap-2">
          {resumes.length > 1 && <Select aria-label="Choose resume" value={sel || ''} onChange={(e) => setSel(e.target.value)} className="!w-auto">{resumes.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</Select>}
          {resumes.length < (list.data?.max || 5) && <Button busy={busy} onClick={create}><Icon name="plus" className="size-4" />New resume</Button>}
        </div>} />
      <Async state={list}>{() => resumes.length === 0
        ? <Empty title="No resume yet" action={<Button busy={busy} onClick={create}>Create from my verified data</Button>}>We'll fill in your education, verified skills, projects and certificates. Only instructor-verified items are included.</Empty>
        : sel && <Editor key={sel} id={sel}
          onRenamed={(id, title) => list.setData({ ...list.data, resumes: list.data.resumes.map((r) => (r.id === id ? { ...r, title } : r)) })}
          onDeleted={async () => { setSel(null); await list.reload(true); }} />}</Async>
    </>
  );
}
