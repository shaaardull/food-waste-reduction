import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, ShieldAlert } from 'lucide-react';
import { api, ApiException } from '../lib/api';
import { LangToggle } from '../components/LangToggle';

/**
 * AcceptInvitation — landing page a restaurant staff member hits from
 * the SES invitation email they were sent from Settings → Staff on the
 * dashboard.
 *
 * The token is a JWT minted by the API's staff_invitation flow (see
 * apps/api/app/routers/restaurant_staff.py). We DON'T decode it in the
 * browser — we call `/staff-invitations/preview` so the render trusts
 * the server's decode instead of shipping a JWT lib client-side. The
 * invitee's email + role + restaurant name shown on this screen come
 * straight from that endpoint.
 *
 * On submit we POST `/staff-invitations/accept`, get back a real auth
 * token, then bounce the invitee to the dashboard (which is a
 * different origin in prod — we can't hand the JWT over via localStorage
 * across origins, so we pass it in the URL fragment where it never
 * hits a server access log). The dashboard's Login screen already
 * handles a `#token=` fragment as a hand-off signal.
 *
 * Failures — expired token, garbled token, already-consumed row — all
 * fall through to a friendly card with a "ask your restaurant owner"
 * fallback CTA.
 */

interface Preview {
  email: string;
  role: 'owner' | 'manager' | 'server';
  restaurant_id: string;
  restaurant_name: string;
}

export function AcceptInvitation() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPreviewErr(t('accept_invite.err_missing_token'));
      return;
    }
    (async () => {
      try {
        const res = await api.get<Preview>(
          `/staff-invitations/preview?token=${encodeURIComponent(token)}`,
        );
        if (!cancelled) setPreview(res);
      } catch (e) {
        if (!cancelled) {
          setPreviewErr(
            e instanceof ApiException ? e.message : t('accept_invite.err_generic'),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !token) return;
    setErr(null);
    if (pwd.length < 8) {
      setErr(t('accept_invite.err_password_short'));
      return;
    }
    if (pwd !== confirm) {
      setErr(t('accept_invite.err_password_mismatch'));
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ token: string }>(
        '/staff-invitations/accept',
        { token, password: pwd },
      );
      setDone(true);
      // Hand the freshly minted staff token to the dashboard. In dev
      // the dashboard sits on a different port; in prod on a different
      // subdomain. Passing via URL fragment keeps the token out of
      // server access logs and referer headers on the target host.
      const dashboardOrigin = dashboardOriginFromCurrent();
      const url =
        `${dashboardOrigin}/login#token=${encodeURIComponent(res.token)}` +
        `&restaurant_id=${encodeURIComponent(preview?.restaurant_id ?? '')}`;
      // Small delay so the "success" card is visible before we bounce.
      window.setTimeout(() => {
        window.location.href = url;
      }, 900);
    } catch (e) {
      setErr(e instanceof ApiException ? e.message : t('accept_invite.err_generic'));
      setBusy(false);
    }
  }

  return (
    <div className="d-screen min-h-full">
      <div className="px-5 pt-4 spread">
        <Link
          to="/"
          className="btn-tertiary !min-h-0 !p-1 inline-flex items-center gap-1.5"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </Link>
        <LangToggle />
      </div>

      <div className="max-w-md mx-auto px-5 pt-6 pb-10 space-y-5">
        <header className="space-y-1">
          <div className="eyebrow text-brand">
            {t('accept_invite.eyebrow')}
          </div>
          <h1 className="display text-[30px] text-ink leading-tight">
            {t('accept_invite.title')}
          </h1>
        </header>

        {previewErr ? (
          <FailureCard message={previewErr} />
        ) : !preview ? (
          <p className="text-sm text-muted">
            {t('accept_invite.loading')}
          </p>
        ) : done ? (
          <div className="rounded-2xl border border-sage/30 bg-sage/10 p-5 flex flex-col items-center gap-2 text-center">
            <div className="w-12 h-12 rounded-full bg-sage/25 text-sage-deep flex items-center justify-center">
              <Check size={20} />
            </div>
            <div className="font-semibold text-[16px] text-ink">
              {t('accept_invite.done_title')}
            </div>
            <p className="text-[13px] text-muted">
              {t('accept_invite.done_body')}
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-line bg-paper p-4 flex flex-col gap-1">
              <div className="text-[11px] font-semibold text-muted dev uppercase tracking-wide">
                {t('accept_invite.invited_to')}
              </div>
              <div className="font-semibold text-[16px] text-ink">
                {preview.restaurant_name}
              </div>
              <div className="text-[13px] text-muted">
                {t('accept_invite.as_role', {
                  email: preview.email,
                  role: t(`accept_invite.role_${preview.role}`),
                })}
              </div>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold text-ink">
                  {t('accept_invite.field_password')}
                </span>
                <input
                  type="password"
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                  className="input mt-0"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold text-ink">
                  {t('accept_invite.field_confirm')}
                </span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                  className="input mt-0"
                />
              </label>
              {err && (
                <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
                  {err}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="btn-primary w-full"
              >
                {busy
                  ? t('accept_invite.submitting')
                  : t('accept_invite.submit')}
              </button>
              <p className="text-[11.5px] text-muted text-center leading-snug">
                {t('accept_invite.footer_hint')}
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function FailureCard({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-danger/25 bg-danger-wash p-5 flex flex-col gap-3 items-start">
      <div className="row gap-2 items-center text-danger font-semibold text-[14px]">
        <ShieldAlert size={16} />
        {t('accept_invite.err_title')}
      </div>
      <p className="text-[13px] text-ink leading-normal">{message}</p>
      <p className="text-[13px] text-muted leading-normal">
        {t('accept_invite.err_fallback')}
      </p>
    </div>
  );
}

/** In dev, the dashboard runs on port 5174 while the diner PWA runs on
 *  5173. In prod, the dashboard sits at dashboard.plateclean.in vs the
 *  diner PWA at plateclean.in. Both cases are computed from the
 *  current origin so we don't need a separate env var. */
function dashboardOriginFromCurrent(): string {
  const { origin, hostname } = window.location;
  if (origin.startsWith('http://localhost:5173')) {
    return 'http://localhost:5174';
  }
  if (hostname.startsWith('dashboard.')) {
    return origin;
  }
  return origin.replace(/:\/\//, '://dashboard.');
}
