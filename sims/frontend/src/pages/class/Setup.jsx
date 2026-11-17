import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, Pill, Select, useAction, useLoad, useToast } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { Tabs } from './shared';

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ----------------------------------------------------------------------------- subjects
function SubjectForm({ initial, onClose, onSaved }) {
  const { url, current } = useClass();
  const [run, busy] = useAction();
  const [f, setF] = useState(initial || { semester: current.current_semester, code: '', name: '', credits: 4, isLab: false });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    const body = { semester: Number(f.semester), code: f.code, name: f.name, credits: Number(f.credits), isLab: Boolean(f.isLab) };
    try { await (initial ? api.patch(url(`/subjects/${initial.id}`), body) : api.post(url('/subjects'), body)); onSaved(); } catch (err) { setError(err); }
  };
  return (
    <Modal open onClose={onClose} title={initial ? 'Edit subject' : 'Add subject'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Semester" error={error?.fields?.semester}><Select value={f.semester} onChange={set('semester')}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1}</option>)}</Select></Field>
          <Field label="Code" error={error?.fields?.code}><Input required maxLength={20} placeholder="CS301" value={f.code} onChange={set('code')} /></Field>
        </div>
        <Field label="Name" error={error?.fields?.name}><Input required maxLength={120} value={f.name} onChange={set('name')} /></Field>
        <div className="grid grid-cols-2 items-end gap-4">
          <Field label="Credits" error={error?.fields?.credits}><Input required type="number" min="0" max="30" step="0.5" value={f.credits} onChange={set('credits')} /></Field>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={f.isLab} onChange={set('isLab')} />Lab subject</label>
        </div>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function SubjectsTab() {
  const { url, current } = useClass();
  const [run] = useAction();
  const q = useLoad(() => api.get(url('/subjects')), [current.id]);
  const [form, setForm] = useState(null);       // null | {} (new) | subject (edit)
  const remove = async (s) => {
    if (!window.confirm(`Delete ${s.code} — ${s.name}?`)) return;
    if (await run(() => api.del(url(`/subjects/${s.id}`)).then(() => true), 'Subject deleted')) q.reload(true);
  };
  return (
    <>
      <div className="mb-4 flex justify-end"><Button size="sm" onClick={() => setForm({})}>+ Add subject</Button></div>
      <Async state={q}>{({ subjects }) => subjects.length === 0 ? <Empty title="No subjects yet">Add the subjects of each semester. They are needed for attendance, marks and the timetable.</Empty> : (
        <div className="space-y-6">
          {[...new Set(subjects.map((s) => s.semester))].map((sem) => (
            <Card key={sem} title={`Semester ${sem}`} pad={false} action={sem === current.current_semester && <Pill tone="brand">Current</Pill>}>
              <ul className="divide-y divide-line">{subjects.filter((s) => s.semester === sem).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0"><b>{s.code}</b> · {s.name} <span className="text-muted">· {s.credits} credits</span> {s.isLab && <Pill tone="info">Lab</Pill>}</span>
                  <span className="flex shrink-0 gap-3 text-xs"><button className="text-muted hover:text-ink" onClick={() => setForm(s)}>Edit</button><button className="text-muted hover:text-bad" onClick={() => remove(s)}>Delete</button></span>
                </li>
              ))}</ul>
            </Card>
          ))}
        </div>
      )}</Async>
      {form && <SubjectForm initial={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => { setForm(null); q.reload(true); }} />}
    </>
  );
}

// ----------------------------------------------------------------------------- timetable
function TimetableTab() {
  const { url, current } = useClass();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const subjects = useLoad(() => api.get(url('/subjects')), [current.id]);
  const tt = useLoad(() => api.get(url('/timetable')), [current.id]);
  const [slots, setSlots] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { if (tt.data) setSlots(tt.data.slots.map(({ subjectId, dayOfWeek, startsAt, endsAt, room }) => ({ subjectId, dayOfWeek, startsAt, endsAt, room: room || '' }))); }, [tt.data]);

  const upd = (i, k, v) => setSlots((l) => l.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const add = () => setSlots((l) => [...l, { subjectId: subjects.data?.subjects[0]?.id || '', dayOfWeek: 1, startsAt: '09:00', endsAt: '10:00', room: '' }]);
  const save = async () => {
    setError(''); setBusy(true);
    try {
      await api.put(url('/timetable'), { slots: slots.map((s) => ({ ...s, dayOfWeek: Number(s.dayOfWeek), room: s.room.trim() || null })) });
      toast('Timetable saved');
      tt.reload(true);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Async state={{ data: tt.data && subjects.data && slots ? tt.data : null, error: tt.error || subjects.error, loading: !(tt.data && subjects.data && slots), reload: tt.reload }}>{() => (
      subjects.data.subjects.length === 0 ? <Empty title="Add subjects first">The timetable is built from your subjects.</Empty> : (
        <Card title="Weekly timetable" action={<Button size="sm" variant="secondary" onClick={add}>+ Add lesson</Button>}>
          {error && <p role="alert" className="mb-4 rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error}</p>}
          {slots.length === 0 ? <p className="text-sm text-muted">No lessons yet.</p> : (
            <ul className="space-y-3">{slots.map((s, i) => (
              <li key={i} className="grid items-end gap-2 sm:grid-cols-[1.6fr_1fr_.8fr_.8fr_.8fr_auto]">
                <label className="text-xs text-muted">Subject<Select value={s.subjectId} onChange={(e) => upd(i, 'subjectId', e.target.value)}>{subjects.data.subjects.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</Select></label>
                <label className="text-xs text-muted">Day<Select value={s.dayOfWeek} onChange={(e) => upd(i, 'dayOfWeek', e.target.value)}>{DAYS.slice(1).map((d, k) => <option key={d} value={k + 1}>{d}</option>)}</Select></label>
                <label className="text-xs text-muted">From<Input type="time" value={s.startsAt} onChange={(e) => upd(i, 'startsAt', e.target.value)} /></label>
                <label className="text-xs text-muted">To<Input type="time" value={s.endsAt} onChange={(e) => upd(i, 'endsAt', e.target.value)} /></label>
                <label className="text-xs text-muted">Room<Input maxLength={40} value={s.room} onChange={(e) => upd(i, 'room', e.target.value)} /></label>
                <button onClick={() => setSlots((l) => l.filter((_, j) => j !== i))} aria-label="Remove lesson" className="pb-2 text-muted hover:text-bad">✕</button>
              </li>
            ))}</ul>
          )}
          <div className="mt-5 flex justify-end"><Button busy={busy} onClick={save}>Save timetable</Button></div>
        </Card>
      )
    )}</Async>
  );
}

// ----------------------------------------------------------------------------- class settings
function SettingsTab() {
  const { url, current, reload } = useClass();
  const d = useLoad(() => api.get(url()), [current.id]);
  const [run, busy] = useAction();
  const [f, setF] = useState(null);
  useEffect(() => {
    const c = d.data?.class; if (!c) return;
    setF({ name: c.name || '', currentSemester: c.current_semester, hodName: c.hod_name || '', instructorName: c.instructor_name || '', instructorPhone: c.instructor_phone || '', instructorEmail: c.instructor_email || '' });
  }, [d.data]);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    await run(async () => {
      await api.patch(url(), { name: f.name, currentSemester: Number(f.currentSemester), hodName: f.hodName.trim() || null, instructorName: f.instructorName, instructorPhone: f.instructorPhone.trim() || null, instructorEmail: f.instructorEmail.trim() || null });
      await reload(true);
    }, 'Class settings saved');
  };
  return (
    <Async state={{ data: f && d.data, error: d.error, loading: !(f && d.data), reload: d.reload }}>{(x) => (
      <Card title="Class settings" className="max-w-2xl">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Class name"><Input required minLength={2} value={f.name} onChange={set('name')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current semester" hint="Drives the default semester across the dashboards."><Select value={f.currentSemester} onChange={set('currentSemester')}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1}</option>)}</Select></Field>
            <Field label="HOD name"><Input value={f.hodName} onChange={set('hodName')} /></Field>
            <Field label="Instructor name"><Input required minLength={2} value={f.instructorName} onChange={set('instructorName')} /></Field>
            <Field label="Instructor phone"><Input value={f.instructorPhone} onChange={set('instructorPhone')} /></Field>
            <div className="sm:col-span-2"><Field label="Instructor e-mail"><Input type="email" value={f.instructorEmail} onChange={set('instructorEmail')} /></Field></div>
          </div>
          <p className="text-xs text-muted">{x.class.department_name} · {x.class.branch} · {x.class.admission_year}–{x.class.passout_year}</p>
          <Button type="submit" busy={busy}>Save changes</Button>
        </form>
      </Card>
    )}</Async>
  );
}

export default function Setup() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'subjects';
  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Class setup" subtitle="Subjects, weekly timetable and class details." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'subjects', label: 'Subjects' }, { id: 'timetable', label: 'Timetable' }, { id: 'settings', label: 'Class settings' }]} />
      {tab === 'timetable' ? <TimetableTab /> : tab === 'settings' ? <SettingsTab /> : <SubjectsTab />}
    </>
  );
}
