import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Icon } from '../../icons';
import { Button, Card, Field, Input, Select, Spinner, ErrorBox, useAction, useLoad } from '../../ui';

/**
 * Everything under /class runs inside <ClassArea/>:
 *   1. instructor not yet approved by the college  → waiting screen
 *   2. approved but no class yet                    → "create your class" form
 *   3. otherwise                                    → the pages, with the selected class available via useClass()
 */
const Ctx = createContext(null);
export const useClass = () => useContext(Ctx);

const KEY = 'sims.class';
const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

function Waiting() {
  const { context, refresh } = useAuth();
  const [run, busy] = useAction();
  return (
    <div className="mx-auto max-w-xl pt-6">
      <Card>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-warn-soft text-warn"><Icon name="shield" className="size-6" /></div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Waiting for your college</h1>
        <p className="mt-2 text-sm text-muted">Your request to join <b className="text-ink">{context?.college}</b> has to be approved by the college admin before you can create a class. You'll be notified as soon as it is.</p>
        <Button className="mt-5" variant="secondary" busy={busy} onClick={() => run(refresh)}>Check status</Button>
      </Card>
    </div>
  );
}

/** First-run: create the class and show its Class Key. */
function CreateClass({ onCreated, first }) {
  const depts = useLoad(() => api.get('/departments'));
  const [run, busy] = useAction();
  const year = new Date().getFullYear();
  const [f, setF] = useState({ departmentId: '', branch: '', admissionYear: year - 1, passoutYear: year + 3, name: '', hodName: '' });
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault(); setError(null);
    try {
      const body = { departmentId: f.departmentId, branch: f.branch, admissionYear: Number(f.admissionYear), passoutYear: Number(f.passoutYear), ...(f.name ? { name: f.name } : {}), ...(f.hodName ? { hodName: f.hodName } : {}) };
      setMade(await api.post('/classes', body));
    } catch (err) { setError(err); }
  };

  if (made) {
    return (
      <div className="mx-auto max-w-xl pt-6">
        <Card>
          <h1 className="text-xl font-semibold tracking-tight">Class created 🎉</h1>
          <p className="mt-2 text-sm text-muted">Share this Class Key with your students. Each request to join needs your approval.</p>
          <div className="mt-4 rounded-2xl border border-line bg-surface-2 p-4 text-center font-mono text-2xl font-semibold tracking-widest">{made.classKey}</div>
          <p className="mt-3 text-xs text-muted">You can find it again (and rotate it) under <b>Join requests</b>.</p>
          <Button className="mt-5" onClick={() => onCreated(made.class.id)}>Open class dashboard</Button>
        </Card>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-xl pt-6">
      <Card>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand"><Icon name="school" className="size-6" /></div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{first ? 'Create your class' : 'Add another class'}</h1>
        <p className="mt-2 text-sm text-muted">{first ? 'You have no class yet. Create one to get a Class Key for your students.' : 'Each class has its own Class Key, students and leaderboard.'}</p>
        {depts.data?.departments.length === 0 && <p className="mt-4 rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn">Your college has no departments yet. Ask the college admin to add one.</p>}
        <form onSubmit={submit} className="mt-5 space-y-4">
          {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
          <Field label="Department" error={error?.fields?.departmentId}>
            <Select required value={f.departmentId} onChange={set('departmentId')}><option value="">Select…</option>{depts.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
          </Field>
          <Field label="Branch" error={error?.fields?.branch}><Input required placeholder="CSE" value={f.branch} onChange={set('branch')} /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Admission year" error={error?.fields?.admissionYear}><Input required type="number" value={f.admissionYear} onChange={set('admissionYear')} /></Field>
            <Field label="Passout year" error={error?.fields?.passoutYear}><Input required type="number" value={f.passoutYear} onChange={set('passoutYear')} /></Field>
          </div>
          <Field label="Class name (optional)" hint="Defaults to “Branch admission–passout”."><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="HOD name (optional)"><Input value={f.hodName} onChange={set('hodName')} /></Field>
          <Button type="submit" busy={busy} className="w-full">Create class</Button>
        </form>
      </Card>
    </div>
  );
}

function Provider() {
  const list = useLoad(() => api.get('/classes'));
  const [sel, setSel] = useState(remembered);
  const [adding, setAdding] = useState(false);

  const classes = list.data?.classes || [];
  const current = classes.find((c) => c.id === sel) || classes[0] || null;
  const select = useCallback((id) => { setSel(id); try { localStorage.setItem(KEY, id); } catch { /* private mode */ } }, []);
  useEffect(() => { if (current && current.id !== sel) select(current.id); }, [current, sel, select]);

  const value = useMemo(() => current && ({
    classId: current.id, current, classes, select, reload: list.reload,
    /** '/classes/<id>' + path — every class API call goes through this */
    url: (path = '') => `/classes/${current.id}${path}`,
    addClass: () => setAdding(true),
  }), [current, classes, select, list.reload]);

  if (list.loading && !list.data) return <Spinner />;
  if (list.error && !list.data) return <ErrorBox error={list.error} retry={list.reload} />;
  if (!current || adding) {
    return <CreateClass first={!current} onCreated={async (id) => { setAdding(false); select(id); await list.reload(true); }} />;
  }
  return <Ctx.Provider value={value}><Outlet /></Ctx.Provider>;
}

export function ClassArea() {
  const { context } = useAuth();
  if (context?.status !== 'approved') return <Waiting />;
  return <Provider />;
}

/** Small selector shown at the top of every class page when the instructor has several classes. */
export function ClassSwitcher() {
  const { classes, current, select, addClass } = useClass();
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      {classes.length > 1
        ? <Select aria-label="Class" className="!w-auto" value={current.id} onChange={(e) => select(e.target.value)}>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        : <span className="font-medium">{current.name}</span>}
      <span className="text-muted">· semester {current.current_semester}</span>
      <button onClick={addClass} className="ml-auto text-xs font-medium text-brand hover:underline">+ Add class</button>
    </div>
  );
}
