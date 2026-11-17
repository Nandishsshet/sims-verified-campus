import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, PageHeader, Pill, Select, fmtDateTime, useAction, useLoad, useToast } from '../../ui';
import { ClassSwitcher, useClass } from './ClassContext';
import { Tabs, download, todayISO } from './shared';

const STATUSES = [['present', 'P', 'bg-good text-white'], ['absent', 'A', 'bg-bad text-white'], ['late', 'L', 'bg-warn text-white'], ['excused', 'E', 'bg-info text-white']];

/** A subject picker that remembers which subjects belong to the class. */
function useSubjects() {
  const { url, current } = useClass();
  return useLoad(() => api.get(url('/subjects')), [current.id]);
}
const NoSubjects = () => <Empty title="Add subjects first">Attendance and marks are recorded per subject. Add them under Setup → Subjects.</Empty>;

// ----------------------------------------------------------------------------- attendance
function AttendanceTab({ subjects }) {
  const { url } = useClass();
  const [run, busy] = useAction();
  const { current } = useClass();
  const [sel, setSel] = useState({ subjectId: (subjects.find((s) => s.semester === current.current_semester) || subjects[0])?.id || '', date: todayISO(), period: 1 });
  const [marks, setMarks] = useState({});
  const sheet = useLoad(() => api.get(url(`/attendance/sheet?subjectId=${sel.subjectId}&date=${sel.date}&period=${sel.period}`)), [sel.subjectId, sel.date, sel.period]);

  useEffect(() => { if (sheet.data) setMarks(Object.fromEntries(sheet.data.students.map((s) => [s.studentId, s.status || '']))); }, [sheet.data]);
  const set = (id, status) => setMarks((m) => ({ ...m, [id]: status }));
  const all = (status) => setMarks((m) => Object.fromEntries(Object.keys(m).map((k) => [k, status])));

  const entries = Object.entries(marks).filter(([, v]) => v).map(([studentId, status]) => ({ studentId, status }));
  const save = async () => {
    const r = await run(() => api.post(url('/attendance'), { subjectId: sel.subjectId, date: sel.date, period: Number(sel.period), entries }));
    if (r) { sheet.reload(true); return `Saved: ${r.inserted} new, ${r.updated} changed`; }
    return null;
  };

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label="Subject"><Select value={sel.subjectId} onChange={(e) => setSel({ ...sel, subjectId: e.target.value })}>{subjects.map((s) => <option key={s.id} value={s.id}>Sem {s.semester} · {s.code} · {s.name}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" max={todayISO()} value={sel.date} onChange={(e) => e.target.value && setSel({ ...sel, date: e.target.value })} /></Field>
        <Field label="Period"><Select value={sel.period} onChange={(e) => setSel({ ...sel, period: Number(e.target.value) })}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>Period {i + 1}</option>)}</Select></Field>
      </div>
      <Async state={sheet}>{({ students }) => students.length === 0 ? <Empty title="No approved students yet" /> : (
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-sm">
            <span className="text-muted">Mark everyone:</span>
            {STATUSES.map(([k, , cls]) => <button key={k} onClick={() => all(k)} className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${cls}`}>{k}</button>)}
            <span className="ml-auto text-xs text-muted">{entries.length}/{students.length} marked</span>
          </div>
          <ul className="divide-y divide-line">
            {students.map((s) => (
              <li key={s.studentId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{s.name}</div><div className="text-xs text-muted">{s.rollNumber || '—'}{s.status && !s.verified ? ' · awaiting verification' : ''}{s.source === 'student' ? ' · student claim' : ''}</div></div>
                <div className="flex gap-1.5" role="radiogroup" aria-label={`Attendance for ${s.name}`}>
                  {STATUSES.map(([k, letter, cls]) => (
                    <button key={k} role="radio" aria-checked={marks[s.studentId] === k} aria-label={k} title={k} onClick={() => set(s.studentId, marks[s.studentId] === k ? '' : k)}
                      className={`size-9 rounded-lg border text-xs font-semibold transition ${marks[s.studentId] === k ? `${cls} border-transparent` : 'border-line text-muted hover:bg-surface-2'}`}>{letter}</button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end border-t border-line px-4 py-3"><SaveButton busy={busy} disabled={entries.length === 0} onSave={save} label="Save attendance" /></div>
        </Card>
      )}</Async>
    </>
  );
}

/** Button that reports the message returned by `onSave` as a toast. */
function SaveButton({ onSave, busy, disabled, label }) {
  const toast = useToast();
  return <Button busy={busy} disabled={disabled} onClick={async () => { const msg = await onSave(); if (msg) toast(msg); }}>{label}</Button>;
}

// ----------------------------------------------------------------------------- marks
function MarksTab({ subjects }) {
  const { url } = useClass();
  const [run, busy] = useAction();
  const { current } = useClass();
  const [sel, setSel] = useState({ subjectId: (subjects.find((s) => s.semester === current.current_semester) || subjects[0])?.id || '', attempt: 1 });
  const [max, setMax] = useState({ internal: 40, external: 60 });
  const [vals, setVals] = useState({});
  const sheet = useLoad(() => api.get(url(`/marks/sheet?subjectId=${sel.subjectId}&attempt=${sel.attempt}`)), [sel.subjectId, sel.attempt]);

  useEffect(() => {
    if (!sheet.data) return;
    setMax({ internal: sheet.data.internalMax, external: sheet.data.externalMax });
    setVals(Object.fromEntries(sheet.data.students.map((s) => [s.studentId, { i: s.internalObtained ?? '', e: s.externalObtained ?? '' }])));
  }, [sheet.data]);

  const set = (id, k, v) => setVals((p) => ({ ...p, [id]: { ...p[id], [k]: v } }));
  const complete = Object.entries(vals).filter(([, v]) => v.i !== '' && v.e !== '');
  const over = (v, m) => v !== '' && Number(v) > Number(m);
  const invalid = complete.some(([, v]) => over(v.i, max.internal) || over(v.e, max.external) || Number(v.i) < 0 || Number(v.e) < 0);

  const save = async () => {
    const r = await run(() => api.post(url('/marks'), {
      subjectId: sel.subjectId, attempt: Number(sel.attempt), internalMax: Number(max.internal), externalMax: Number(max.external),
      entries: complete.map(([studentId, v]) => ({ studentId, internalObtained: Number(v.i), externalObtained: Number(v.e) })),
    }));
    if (r) { sheet.reload(true); return `Saved: ${r.inserted} new, ${r.updated} changed`; }
    return null;
  };

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2"><Field label="Subject"><Select value={sel.subjectId} onChange={(e) => setSel({ ...sel, subjectId: e.target.value })}>{subjects.map((s) => <option key={s.id} value={s.id}>Sem {s.semester} · {s.code} · {s.name}</option>)}</Select></Field></div>
        <Field label="Attempt" hint="2+ = supplementary"><Select value={sel.attempt} onChange={(e) => setSel({ ...sel, attempt: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n === 1 ? 'Regular' : `Attempt ${n}`}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Internal max"><Input type="number" min="0" value={max.internal} onChange={(e) => setMax({ ...max, internal: e.target.value })} /></Field>
          <Field label="External max"><Input type="number" min="0" value={max.external} onChange={(e) => setMax({ ...max, external: e.target.value })} /></Field>
        </div>
      </div>
      <Async state={sheet}>{({ students }) => students.length === 0 ? <Empty title="No approved students yet" /> : (
        <Card pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Student</th><th className="w-32 px-4 py-3">Internal /{max.internal}</th><th className="w-32 px-4 py-3">External /{max.external}</th><th className="w-24 px-4 py-3">Total</th></tr></thead>
              <tbody className="divide-y divide-line">
                {students.map((s) => {
                  const v = vals[s.studentId] || { i: '', e: '' };
                  const total = v.i !== '' && v.e !== '' ? Number(v.i) + Number(v.e) : null;
                  return (
                    <tr key={s.studentId}>
                      <td className="px-4 py-2"><div className="font-medium">{s.name}</div><div className="text-xs text-muted">{s.rollNumber || '—'}{s.internalObtained != null && !s.verified ? ' · awaiting verification' : ''}</div></td>
                      <td className="px-4 py-2"><Input type="number" min="0" step="0.5" aria-label={`Internal marks for ${s.name}`} value={v.i} onChange={(e) => set(s.studentId, 'i', e.target.value)} className={over(v.i, max.internal) ? '!border-bad' : ''} /></td>
                      <td className="px-4 py-2"><Input type="number" min="0" step="0.5" aria-label={`External marks for ${s.name}`} value={v.e} onChange={(e) => set(s.studentId, 'e', e.target.value)} className={over(v.e, max.external) ? '!border-bad' : ''} /></td>
                      <td className="px-4 py-2 tabular-nums text-muted">{total ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <span className={`text-xs ${invalid ? 'text-bad' : 'text-muted'}`}>{invalid ? 'Some marks exceed the maximum.' : `${complete.length}/${students.length} students have both marks.`}</span>
            <SaveButton busy={busy} disabled={complete.length === 0 || invalid} onSave={save} label="Save marks" />
          </div>
        </Card>
      )}</Async>
    </>
  );
}

// ----------------------------------------------------------------------------- CSV import
function ImportTab() {
  const { url } = useClass();
  const [run, busy] = useAction();
  const [kind, setKind] = useState('attendance');
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);
  const [done, setDone] = useState(null);
  const input = useRef(null);
  const history = useLoad(() => api.get(url('/imports')), []);

  const pick = (f) => { setFile(f || null); setCheck(null); setDone(null); };
  const post = (dry) => { const form = new FormData(); form.append('file', file); return api.upload(url(`/${kind}/import${dry ? '?dryRun=1' : ''}`), form); };
  const validate = async () => { setDone(null); setCheck(await run(() => post(true))); };
  const commit = async () => {
    const r = await run(() => post(false), 'Import finished');
    if (r) { setDone(r); setCheck(null); setFile(null); if (input.current) input.current.value = ''; history.reload(true); }
  };

  const Report = ({ r }) => r.errorReport.length > 0 && (
    <div className="mt-4 overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[420px] text-left text-xs">
        <thead className="bg-surface-2 text-muted"><tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Column</th><th className="px-3 py-2">Problem</th></tr></thead>
        <tbody className="divide-y divide-line">{r.errorReport.map((e, i) => <tr key={i}><td className="px-3 py-1.5 tabular-nums">{e.row}</td><td className="px-3 py-1.5">{e.field}</td><td className="px-3 py-1.5">{e.message}</td></tr>)}</tbody>
      </table>
      {r.moreErrors > 0 && <p className="border-t border-line px-3 py-2 text-xs text-muted">…and {r.moreErrors} more problems.</p>}
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Upload a CSV" className="lg:col-span-2">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What are you importing?"><Select value={kind} onChange={(e) => { setKind(e.target.value); pick(null); if (input.current) input.current.value = ''; }}><option value="attendance">Attendance</option><option value="marks">Marks</option></Select></Field>
            <div className="flex items-end"><Button variant="secondary" size="sm" onClick={() => run(() => download(url(`/imports/template/${kind}`), `${kind}-template.csv`))}>Download template</Button></div>
          </div>
          <Field label="CSV file" hint="Up to 1 MB and 5,000 rows. Rows are checked first — nothing is saved until you confirm.">
            <input ref={input} type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand" />
          </Field>
          <Button busy={busy} disabled={!file} onClick={validate}>Check file</Button>

          {check && (
            <div role="status" className="rounded-xl border border-line p-4">
              <div className="flex flex-wrap gap-2 text-sm"><Pill tone="muted">{check.totalRows} rows</Pill><Pill tone="good">{check.okRows} ready</Pill>{check.errorRows > 0 && <Pill tone="bad">{check.errorRows} with problems</Pill>}</div>
              <Report r={check} />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button busy={busy} disabled={check.okRows === 0} onClick={commit}>Import {check.okRows} valid row{check.okRows === 1 ? '' : 's'}</Button>
                <span className="text-xs text-muted">{check.errorRows > 0 ? 'Rows with problems are skipped. Fix them in the file and import again.' : 'Imported rows are saved as verified.'}</span>
              </div>
            </div>
          )}
          {done && (
            <div role="status" className="rounded-xl bg-good-soft p-4 text-sm text-good">
              Import complete: <b>{done.inserted}</b> added, <b>{done.updated}</b> updated{done.errorRows > 0 ? `, ${done.errorRows} skipped` : ''}.
              <Report r={done} />
            </div>
          )}
        </div>
      </Card>
      <Card title="Recent imports" pad={false}>
        <Async state={history}>{({ imports }) => imports.length === 0 ? <p className="p-5 text-sm text-muted">No imports yet.</p> : (
          <ul className="divide-y divide-line">{imports.slice(0, 8).map((j) => (
            <li key={j.id} className="px-5 py-3 text-sm"><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-medium">{j.fileName}</span><Pill tone={j.status === 'done' ? 'good' : 'bad'}>{j.status}</Pill></div>
              <div className="mt-0.5 text-xs text-muted capitalize">{j.kind} · {j.okRows}/{j.totalRows} rows · {fmtDateTime(j.createdAt)}</div></li>
          ))}</ul>
        )}</Async>
      </Card>
    </div>
  );
}

export default function DataEntry() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'attendance';
  const subjects = useSubjects();
  return (
    <>
      <ClassSwitcher />
      <PageHeader title="Data entry" subtitle="Records you enter or import are saved as verified." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ id: 'attendance', label: 'Attendance' }, { id: 'marks', label: 'Marks' }, { id: 'import', label: 'CSV import' }]} />
      {tab === 'import' ? <ImportTab /> : (
        <Async state={subjects}>{({ subjects: list }) => list.length === 0 ? <NoSubjects /> : tab === 'marks' ? <MarksTab subjects={list} /> : <AttendanceTab subjects={list} />}</Async>
      )}
    </>
  );
}
