import { useState } from 'react';
import { api } from '../../api';
import { Icon } from '../../icons';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Select, StatusChip, Textarea, fmtDate, useAction, useLoad } from '../../ui';
import { SkillPicker } from './shared';

const TYPES = { project: 'Projects', internship: 'Internships', publication: 'Publications' };
const ORG = { project: 'Organisation / context (optional)', internship: 'Company', publication: 'Journal / venue' };

function ItemForm({ open, onClose, onDone, edit, defaultType }) {
  const [run, busy] = useAction();
  const [f, setF] = useState(() => ({
    type: edit?.type || defaultType, title: edit?.title || '', organization: edit?.organization || '', role: edit?.role || '', description: edit?.description || '',
    bullets: (edit?.bullets || []).join('\n'), techStack: (edit?.techStack || []).join(', '), url: edit?.url || '',
    startDate: edit?.startDate?.slice(0, 10) || '', endDate: edit?.endDate?.slice(0, 10) || '',
    skills: edit?.skills?.map(({ skillId, proficiency }) => ({ skillId, proficiency })) || [],
  }));
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    const body = {
      title: f.title, organization: f.organization || null, role: f.role || null, description: f.description || null,
      bullets: f.bullets.split('\n').map((x) => x.trim()).filter(Boolean),
      techStack: f.techStack.split(',').map((x) => x.trim()).filter(Boolean),
      url: f.url || null, startDate: f.startDate || null, endDate: f.endDate || null, skills: f.skills,
    };
    const ok = await run(() => (edit ? api.patch(`/student/portfolio/${edit.id}`, body) : api.post('/student/portfolio', { type: f.type, ...body })),
      edit ? 'Updated — sent back for verification' : 'Saved — your instructor will verify it');
    if (ok) { onDone(); onClose(); }
  };

  return (
    <Modal open={open} onClose={onClose} title={`${edit ? 'Edit' : 'Add'} ${f.type}`} wide>
      <form onSubmit={submit} className="space-y-4">
        {!edit && <Field label="Type"><Select value={f.type} onChange={set('type')}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v.replace(/s$/, '')}</option>)}</Select></Field>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title"><Input required minLength={2} maxLength={200} value={f.title} onChange={set('title')} /></Field>
          <Field label={ORG[f.type]}><Input value={f.organization} onChange={set('organization')} /></Field>
          <Field label="Your role"><Input value={f.role} onChange={set('role')} placeholder="Team lead, Developer…" /></Field>
          <Field label="Link (optional)"><Input type="url" placeholder="https://github.com/…" value={f.url} onChange={set('url')} /></Field>
          <Field label="Start"><Input type="date" value={f.startDate} onChange={set('startDate')} /></Field>
          <Field label="End"><Input type="date" value={f.endDate} onChange={set('endDate')} /></Field>
        </div>
        <Field label="Short description"><Textarea maxLength={1000} value={f.description} onChange={set('description')} /></Field>
        <Field label="Resume bullet points" hint="One per line. Start with a verb and include a number — e.g. “Cut page load time by 40%”. These feed your resume."><Textarea rows={4} value={f.bullets} onChange={set('bullets')} /></Field>
        <Field label="Tech stack" hint="Comma-separated"><Input value={f.techStack} onChange={set('techStack')} placeholder="React, Node.js, PostgreSQL" /></Field>
        <div><span className="mb-1.5 block text-sm font-medium">Skills this proves</span><SkillPicker value={f.skills} onChange={(skills) => setF((p) => ({ ...p, skills }))} /></div>
        <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

export default function Portfolio() {
  const [type, setType] = useState('project');
  const s = useLoad(() => api.get('/student/portfolio'));
  const [form, setForm] = useState(null);
  const [run] = useAction();
  const remove = (it) => confirm(`Delete “${it.title}”?`) && run(async () => { await api.del(`/student/portfolio/${it.id}`); s.reload(true); }, 'Deleted');

  return (
    <>
      <PageHeader title="Projects & Portfolio" subtitle="Projects, internships and publications. Verified entries power your resume and placement score."
        action={<Button onClick={() => setForm({})}><Icon name="plus" className="size-4" />Add {type}</Button>} />
      <Async state={s}>{(d) => {
        const list = d.items.filter((i) => i.type === type);
        return (<>
          <div className="mb-4 flex gap-2" role="tablist">{Object.entries(TYPES).map(([k, v]) => (
            <button key={k} role="tab" aria-selected={type === k} onClick={() => setType(k)} className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${type === k ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:bg-surface-2'}`}>{v} ({d.items.filter((i) => i.type === k).length})</button>
          ))}</div>
          {list.length === 0 ? <Empty title={`No ${TYPES[type].toLowerCase()} yet`} action={<Button onClick={() => setForm({})}>Add one</Button>}>Add real work you have done — your instructor verifies it before it counts.</Empty> : (
            <div className="grid gap-4 md:grid-cols-2">{list.map((it) => (
              <Card key={it.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><h3 className="font-semibold leading-snug">{it.title}</h3><p className="mt-0.5 text-sm text-muted">{[it.role, it.organization].filter(Boolean).join(' · ')}{it.startDate ? ` · ${fmtDate(it.startDate, { month: 'short', year: 'numeric' })}${it.endDate ? ` – ${fmtDate(it.endDate, { month: 'short', year: 'numeric' })}` : ''}` : ''}</p></div>
                  <StatusChip status={it.status} />
                </div>
                {it.description && <p className="mt-3 text-sm">{it.description}</p>}
                {it.bullets.length > 0 && <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted">{it.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
                <div className="mt-3 flex flex-wrap gap-1.5">{it.techStack.map((t) => <Pill key={t} tone="brand">{t}</Pill>)}{it.skills.map((k) => <Pill key={k.skillId}>{k.name}</Pill>)}</div>
                {it.remarks && it.status !== 'verified' && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-sm"><b>Instructor:</b> {it.remarks}</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  {it.url && <a href={it.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-xs font-medium hover:bg-surface-2"><Icon name="link" className="size-3.5" />Open link</a>}
                  <Button size="sm" variant="ghost" onClick={() => setForm(it)}><Icon name="edit" className="size-4" />Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(it)} aria-label={`Delete ${it.title}`}><Icon name="trash" className="size-4 text-bad" /></Button>
                </div>
              </Card>
            ))}</div>
          )}
        </>);
      }}</Async>
      {form && <ItemForm key={form.id || 'new'} open edit={form.id ? form : null} defaultType={type} onClose={() => setForm(null)} onDone={() => s.reload(true)} />}
    </>
  );
}
