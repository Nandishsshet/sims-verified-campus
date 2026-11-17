import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { fmtDate, Spinner, useLoad } from '../ui';

/** Public page behind a certificate's QR code. No login; reveals only name, title, issuer and institution. */
export default function VerifyCertificate() {
  const { code } = useParams();
  const s = useLoad(() => api.get(`/verify/${encodeURIComponent(code)}`).then((d) => ({ ok: true, d })).catch((e) => (e.status === 404 ? { ok: false } : Promise.reject(e))), [code]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-8 text-center shadow-sm">
        {s.loading && !s.data ? <Spinner label="Checking" /> : s.error ? (
          <p className="text-sm text-bad">We couldn't check this right now. Please try again in a moment.</p>
        ) : s.data.ok ? (
          <>
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-good-soft text-good"><Icon name="shield" className="size-8" /></div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight text-good">Verified certificate</h1>
            <p className="mt-1 text-sm text-muted">Confirmed by the issuing institution through SIMS.</p>
            <dl className="mt-6 space-y-3 rounded-2xl bg-surface-2 p-5 text-left text-sm">
              {[['Holder', s.data.d.holder], ['Certificate', s.data.d.title], ['Issued by', s.data.d.issuer], ['Institution', s.data.d.institution], ['Verified on', fmtDate(s.data.d.verifiedAt)]].map(([k, v]) => v && (
                <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{k}</dt><dd className="text-right font-medium">{v}</dd></div>
              ))}
            </dl>
            <p className="mt-5 font-mono text-xs tracking-wider text-muted">{String(code).toUpperCase()}</p>
          </>
        ) : (
          <>
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-bad-soft text-bad"><Icon name="x" className="size-8" /></div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight text-bad">Not verified</h1>
            <p className="mt-2 text-sm text-muted">No verified certificate matches this code. It may be mistyped, still awaiting verification, or no longer valid.</p>
          </>
        )}
      </div>
    </div>
  );
}
