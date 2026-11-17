import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async, Button, Card, Empty, Field, Input, Modal, PageHeader, useAction, useLoad } from '../../ui';

/** Create or edit a department. Field errors from the API (e.g. a duplicate code) show under the field. */
function DepartmentModal({ dept, onClose, onSaved }) {
  const [f, setF] = useState({ name: dept?.name ?? '', code: dept?.code ?? '', hodName: dept?.hod_name ?? '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      if (dept) await api.patch(`/college/departments/${dept.id}`, { name: f.name, code: f.code, hodName: f.hodName.trim() || null });
      else await api.post('/college/departments', { name: f.name, code: f.code, ...(f.hodName.trim() ? { hodName: f.hodName } : {}) });
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={dept ? 'Edit department' : 'Add department'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div>}
        <Field label="Name" error={error?.fields?.name}><Input required minLength={2} maxLength={120} placeholder="Computer Science & Engineering" value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Code" error={error?.fields?.code} hint="Short and unique in your college, e.g. CSE."><Input required minLength={2} maxLength={12} className="uppercase" value={f.code} onChange={set('code')} /></Field>
        <Field label="Head of department (optional)" error={error?.fields?.hodName}><Input maxLength={120} value={f.hodName} onChange={set('hodName')} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>{dept ? 'Save changes' : 'Add department'}</Button></div>
      </form>
    </Modal>
  );
}

export default function Departments() {
  const q = useLoad(() => api.get('/college/departments'));
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);                 // null | 'new' | department row

  const done = () => { setModal(null); q.reload(true); };
  const remove = async (d) => {
    if (!window.confirm(`Delete the ${d.name} department? This only works while it has no classes.`)) return;
    if (await run(() => api.del(`/college/departments/${d.id}`).then(() => true), 'Department deleted')) q.reload(true);
  };

  return (
    <>
      <PageHeader title="Departments" subtitle="Instructors pick a department when they create a class; department scores roll up from those classes."
        action={<Button onClick={() => setModal('new')}>Add department</Button>} />
      <Async state={q}>{({ departments }) => departments.length === 0 ? (
        <Empty title="No departments yet" action={<Button onClick={() => setModal('new')}>Add department</Button>}>Create at least one department so instructors can create classes.</Empty>
      ) : (
        <Card pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-3">Department</th><th className="px-3 py-3">HOD</th><th className="px-3 py-3 text-right">Classes</th><th className="px-3 py-3 text-right">Students</th><th className="px-3 py-3 text-right">Instructors</th><th className="px-5 py-3" /></tr></thead>
              <tbody className="divide-y divide-line">
                {departments.map((d) => (
                  <tr key={d.id} className="hover:bg-surface-2/60">
                    <td className="px-5 py-3"><Link to={`/college/departments/${d.id}`} className="font-medium hover:text-brand">{d.name}</Link> <span className="text-xs text-muted">{d.code}</span></td>
                    <td className="px-3 py-3 text-muted">{d.hod_name || '—'}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{d.classes}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{d.students}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{d.instructors}</td>
                    <td className="px-5 py-3"><div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setModal(d)}>Edit</Button>
                      <Button size="sm" variant="ghost" busy={busy} disabled={d.classes > 0} title={d.classes > 0 ? 'Departments with classes cannot be deleted' : 'Delete'} onClick={() => remove(d)}>Delete</Button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}</Async>
      {modal && <DepartmentModal dept={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={done} />}
    </>
  );
}
