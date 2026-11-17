import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/* ---------------------------------------------------------------- data loading */
/** const { data, error, loading, reload } = useLoad(() => api.get('/x'), [deps]) */
export function useLoad(fn, deps = []) {
  const [s, setS] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn); fnRef.current = fn;
  const seq = useRef(0);
  const reload = useCallback(async (silent = false) => {
    const mine = ++seq.current;
    if (!silent) setS((p) => ({ ...p, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      if (mine === seq.current) setS({ data, error: null, loading: false });
    } catch (error) {
      if (mine === seq.current) setS((p) => ({ data: p.data, error, loading: false }));
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  return { ...s, reload, setData: (data) => setS((p) => ({ ...p, data })) };
}

/* ---------------------------------------------------------------- toasts */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, kind = 'ok') => {
    const id = Math.random();
    setItems((l) => [...l, { id, message, kind }]);
    setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`rounded-xl border px-4 py-3 text-sm shadow-lg ${t.kind === 'error' ? 'border-bad/40 bg-bad-soft text-bad' : 'border-good/40 bg-good-soft text-good'}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------------------------------------------- layout atoms */
export const Card = ({ title, action, children, className = '', pad = true }) => (
  <section className={`rounded-2xl border border-line bg-surface ${className}`}>
    {(title || action) && (
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {action}
      </header>
    )}
    <div className={pad ? 'p-5' : ''}>{children}</div>
  </section>
);

export const PageHeader = ({ title, subtitle, action }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
    </div>
    {action}
  </div>
);

export const Stat = ({ label, value, hint, tone = 'default', icon }) => {
  const color = { default: 'text-ink', good: 'text-good', warn: 'text-warn', bad: 'text-bad', brand: 'text-brand' }[tone];
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted">{label}{icon}</div>
      <div className={`mt-2 text-3xl font-semibold tabular-nums tracking-tight ${color}`}>{value ?? '—'}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
};

export const Spinner = ({ label = 'Loading' }) => (
  <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted" role="status">
    <span className="size-5 animate-spin rounded-full border-2 border-line border-t-brand" />{label}…
  </div>
);

export const Empty = ({ title, children, action }) => (
  <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
    <p className="font-medium">{title}</p>
    {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const ErrorBox = ({ error, retry }) => (
  <div className="rounded-2xl border border-bad/30 bg-bad-soft p-5 text-sm text-bad" role="alert">
    <p className="font-medium">Something went wrong</p>
    <p className="mt-1 opacity-90">{error?.message || 'Unexpected error'}</p>
    {retry && <button onClick={retry} className="mt-3 rounded-lg border border-bad/40 px-3 py-1.5 font-medium hover:bg-bad/10">Try again</button>}
  </div>
);

/** Render loading / error / content for a useLoad() result. */
export const Async = ({ state, children }) => {
  if (state.loading && !state.data) return <Spinner />;
  if (state.error && !state.data) return <ErrorBox error={state.error} retry={state.reload} />;
  return children(state.data);
};

/* ---------------------------------------------------------------- form atoms */
export const Button = ({ variant = 'primary', size = 'md', busy, className = '', children, ...p }) => {
  const v = {
    primary: 'bg-brand text-brand-ink hover:opacity-90',
    secondary: 'border border-line bg-surface hover:bg-surface-2',
    ghost: 'hover:bg-surface-2',
    danger: 'bg-bad text-white hover:opacity-90',
  }[variant];
  const s = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm';
  return (
    <button {...p} disabled={p.disabled || busy} className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${v} ${s} ${className}`}>
      {busy && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}{children}
    </button>
  );
};

const inputCls = 'w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:opacity-60';
export const Field = ({ label, error, hint, children }) => (
  <label className="block text-sm">
    <span className="mb-1.5 block font-medium">{label}</span>
    {children}
    {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    {error && <span className="mt-1 block text-xs text-bad" role="alert">{error}</span>}
  </label>
);
export const Input = (p) => <input {...p} className={`${inputCls} ${p.className || ''}`} />;
export const Textarea = (p) => <textarea rows={3} {...p} className={`${inputCls} ${p.className || ''}`} />;
export const Select = ({ children, ...p }) => <select {...p} className={`${inputCls} ${p.className || ''}`}>{children}</select>;

export function Modal({ open, onClose, title, children, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface shadow-2xl sm:rounded-2xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-2">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- status chips & bars */
const CHIP = {
  verified: ['Verified', 'bg-good-soft text-good'],
  pending: ['Pending review', 'bg-warn-soft text-warn'],
  rejected: ['Rejected', 'bg-bad-soft text-bad'],
  correction_requested: ['Needs correction', 'bg-info-soft text-info'],
};
export const StatusChip = ({ status }) => {
  const [text, cls] = CHIP[status] || [status, 'bg-surface-2 text-muted'];
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{status === 'verified' && '✓'} {text}</span>;
};
export const Pill = ({ tone = 'muted', children }) => {
  const cls = { muted: 'bg-surface-2 text-muted', good: 'bg-good-soft text-good', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', brand: 'bg-brand-soft text-brand', info: 'bg-info-soft text-info' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
};

export const Progress = ({ value, tone, label }) => {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  // full class names (not template strings) so Tailwind can see them at build time
  const color = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', brand: 'bg-brand' }[tone] || (v >= 75 ? 'bg-good' : v >= 50 ? 'bg-warn' : 'bg-bad');
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${v}%` }} />
    </div>
  );
};

/* ---------------------------------------------------------------- misc */
export const fmtDate = (d, opts) => (d ? new Date(d).toLocaleDateString(undefined, opts || { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const num = (v, digits = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(digits).replace(/\.0+$/, ''));

/** Debounce a value (used by search boxes). */
export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Run an async action with busy + toast handling:  const [run, busy] = useAction() */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMessage) => {
    setBusy(true);
    try { const r = await fn(); if (okMessage) toast(okMessage); return r; }
    catch (e) { toast(e.message || 'Something went wrong', 'error'); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}
