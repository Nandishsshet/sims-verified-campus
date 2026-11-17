import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Button, Field, Input, Select } from '../ui';

export const HOME = { student: '/student', instructor: '/class', college_admin: '/college', university_head: '/university' };

function Shell({ title, subtitle, children, footer }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_32rem]">
      <div className="relative hidden overflow-hidden bg-brand text-brand-ink lg:block">
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, #fff 0, transparent 40%), radial-gradient(circle at 80% 70%, #fff 0, transparent 35%)' }} />
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-white/20"><Icon name="school" /></span><span className="text-lg font-semibold">SIMS</span></div>
          <div>
            <h2 className="max-w-md text-4xl font-semibold leading-tight tracking-tight">One verified record, from classroom to campus to university.</h2>
            <ul className="mt-8 space-y-3 text-sm opacity-90">
              {['Attendance, marks and certificates verified by your instructor', 'Resume builder with an ATS score, built from verified data', 'Skill-gap roadmap for the career you want', 'Class, college and university rankings you can trust'].map((t) => (
                <li key={t} className="flex gap-3"><Icon name="check" className="mt-0.5 size-4 shrink-0" />{t}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs opacity-70">Student Information Management System</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-7">{children}</div>
          {footer && <p className="mt-6 text-center text-sm text-muted">{footer}</p>}
        </div>
      </div>
    </div>
  );
}

const useForm = (initial) => {
  const [v, setV] = useState(initial);
  const bind = (name) => ({ name, value: v[name] ?? '', onChange: (e) => setV((p) => ({ ...p, [name]: e.target.value })) });
  return [v, bind, setV];
};

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

const FormError = ({ error }) => error ? <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error.message}</div> : null;

/* ---------------------------------------------------------------- login */
export function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [f, bind] = useForm({ email: '', password: '' });
  const { busy, error, submit } = useSubmit(async () => {
    const s = await login(f.email, f.password);
    nav(params.get('next') || HOME[s.user.role], { replace: true });
  });
  if (user) return <Navigate to={HOME[user.role]} replace />;
  return (
    <Shell title="Welcome back" subtitle="Sign in to your SIMS account." footer={<>New here? <Link to="/signup" className="font-medium text-brand hover:underline">Create an account</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />
        <Field label="Email"><Input type="email" autoComplete="email" required autoFocus {...bind('email')} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required {...bind('password')} /></Field>
        <div className="text-right text-sm"><Link to="/forgot-password" className="text-brand hover:underline">Forgot password?</Link></div>
        <Button type="submit" busy={busy} className="w-full">Sign in</Button>
      </form>
    </Shell>
  );
}

/* ---------------------------------------------------------------- signup */
const ROLES = [
  { key: 'student', path: 'student', label: 'Student', hint: 'Join your class with a Class Key after signing up.' },
  { key: 'instructor', path: 'instructor', label: 'Instructor', hint: 'You need the College Key from your college admin.' },
  { key: 'college_admin', path: 'college-admin', label: 'College Admin', hint: 'You need the University Key from your university head.' },
  { key: 'university_head', path: 'university-head', label: 'University Head', hint: 'Registers the university and receives the University Key.' },
];

export function Signup() {
  const { user, signup } = useAuth();
  const nav = useNavigate();
  const [role, setRole] = useState(ROLES[0]);
  const [f, bind] = useForm({ headTitle: 'Vice-Chancellor' });
  const { busy, error, submit } = useSubmit(async () => {
    const body = { fullName: f.fullName, email: f.email, password: f.password, ...(f.phone ? { phone: f.phone } : {}) };
    if (role.key === 'instructor') body.collegeKey = f.collegeKey;
    if (role.key === 'college_admin') {
      body.universityKey = f.universityKey;
      body.college = { name: f.collegeName, principalName: f.principalName, ...(f.affiliation ? { affiliation: f.affiliation } : {}), ...(f.address ? { address: f.address } : {}) };
    }
    if (role.key === 'university_head') body.university = { name: f.universityName, headTitle: f.headTitle, ...(f.address ? { address: f.address } : {}) };
    const s = await signup(role.path, body);
    nav(HOME[s.user.role], { replace: true, state: { welcome: s } });
  });
  if (user) return <Navigate to={HOME[user.role]} replace />;
  const fe = error?.fields || {};

  return (
    <Shell title="Create your account" subtitle="Pick your role — each role sees only its own level of data." footer={<>Already registered? <Link to="/login" className="font-medium text-brand hover:underline">Sign in</Link></>}>
      <div className="mb-5 grid grid-cols-2 gap-2" role="tablist" aria-label="Account type">
        {ROLES.map((r) => (
          <button key={r.key} type="button" role="tab" aria-selected={role.key === r.key} onClick={() => setRole(r)}
            className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${role.key === r.key ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:bg-surface-2'}`}>{r.label}</button>
        ))}
      </div>
      <p className="mb-4 text-xs text-muted">{role.hint}</p>
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />
        <Field label="Full name" error={fe.fullName}><Input required autoComplete="name" {...bind('fullName')} /></Field>
        <Field label="Email" error={fe.email}><Input type="email" required autoComplete="email" {...bind('email')} /></Field>
        <Field label="Password" error={fe.password} hint="At least 8 characters with a letter and a number."><Input type="password" required minLength={8} autoComplete="new-password" {...bind('password')} /></Field>
        <Field label="Phone (optional)" error={fe.phone}><Input type="tel" autoComplete="tel" {...bind('phone')} /></Field>

        {role.key === 'instructor' && <Field label="College Key" error={fe.collegeKey} hint="Looks like COL-XXXX-XXXX"><Input required placeholder="COL-XXXX-XXXX" className="font-mono uppercase" {...bind('collegeKey')} /></Field>}
        {role.key === 'college_admin' && (<>
          <Field label="University Key" error={fe.universityKey} hint="Looks like UNI-XXXX-XXXX"><Input required placeholder="UNI-XXXX-XXXX" className="font-mono uppercase" {...bind('universityKey')} /></Field>
          <Field label="College name" error={fe['college.name']}><Input required {...bind('collegeName')} /></Field>
          <Field label="Principal / Director" error={fe['college.principalName']}><Input required {...bind('principalName')} /></Field>
          <Field label="Affiliation (optional)"><Input {...bind('affiliation')} /></Field>
          <Field label="Address (optional)"><Input {...bind('address')} /></Field>
        </>)}
        {role.key === 'university_head' && (<>
          <Field label="University name" error={fe['university.name']}><Input required {...bind('universityName')} /></Field>
          <Field label="Your title"><Select {...bind('headTitle')}><option>Vice-Chancellor</option><option>Chancellor</option><option>Head</option></Select></Field>
          <Field label="Address (optional)"><Input {...bind('address')} /></Field>
        </>)}
        <Button type="submit" busy={busy} className="w-full">Create account</Button>
      </form>
    </Shell>
  );
}

/* ---------------------------------------------------------------- password reset */
export function Forgot() {
  const [f, bind] = useForm({ email: '' });
  const [sent, setSent] = useState(false);
  const { busy, error, submit } = useSubmit(async () => { await api.post('/auth/forgot-password', { email: f.email }); setSent(true); });
  return (
    <Shell title="Reset your password" subtitle="We'll email you a single-use link." footer={<Link to="/login" className="font-medium text-brand hover:underline">Back to sign in</Link>}>
      {sent ? (
        <div className="rounded-xl border border-good/30 bg-good-soft p-4 text-sm text-good">If that email is registered, a reset link is on its way. It expires shortly and works once.</div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <FormError error={error} />
          <Field label="Email"><Input type="email" required autoFocus {...bind('email')} /></Field>
          <Button type="submit" busy={busy} className="w-full">Send reset link</Button>
        </form>
      )}
    </Shell>
  );
}

export function Reset() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [f, bind] = useForm({ password: '' });
  const [done, setDone] = useState(false);
  const token = params.get('token') || '';
  const { busy, error, submit } = useSubmit(async () => { await api.post('/auth/reset-password', { token, password: f.password }); setDone(true); setTimeout(() => nav('/login'), 1800); });
  return (
    <Shell title="Choose a new password" footer={<Link to="/login" className="font-medium text-brand hover:underline">Back to sign in</Link>}>
      {!token ? <FormError error={{ message: 'This reset link is incomplete. Request a new one.' }} />
        : done ? <div className="rounded-xl border border-good/30 bg-good-soft p-4 text-sm text-good">Password updated. Redirecting to sign in…</div>
          : (
            <form onSubmit={submit} className="space-y-4">
              <FormError error={error} />
              <Field label="New password" hint="At least 8 characters with a letter and a number."><Input type="password" required minLength={8} autoComplete="new-password" autoFocus {...bind('password')} /></Field>
              <Button type="submit" busy={busy} className="w-full">Update password</Button>
            </form>
          )}
    </Shell>
  );
}
