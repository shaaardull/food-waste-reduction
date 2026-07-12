import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, QrCode, Loader2 } from 'lucide-react';
import type { Restaurant } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LangToggle } from '../components/LangToggle';

/**
 * QrResolve — the landing page for /qr/:token.
 *
 * Called by a diner scanning a pre-printed sticker. Behaviour:
 *
 *   1. Resolve the token via `GET /qr/:token/resolve` (public — the
 *      diner hasn't signed in yet at scan time).
 *   2. If bound: cache the resolved (restaurant, table_code) in
 *      sessionStorage, then send the diner into the onboarding
 *      choice flow. Once they finish auth, the session-creation code
 *      picks up those hints and skips the manual restaurant + table
 *      picker.
 *   3. If already signed in: skip auth and try to open a session
 *      immediately (POST /sessions with the pair we resolved).
 *   4. If unassigned / retired / unknown: show a friendly copy card
 *      with a clear "ask staff" nudge — no dead-end error page.
 */

interface ResolveOut {
  token: string;
  state: 'unassigned' | 'assigned' | 'retired';
  restaurant_id?: string | null;
  restaurant_name?: string | null;
  restaurant_slug?: string | null;
  table_code?: string | null;
}

interface SessionCreateOut {
  session_id: string;
  expires_at: string;
  before_capture_nonce: string;
}

export function QrResolve() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token: qrToken = '' } = useParams();
  const token = useAuthStore((s) => s.token);
  const setActiveRestaurant = useAuthStore((s) => s.setActiveRestaurant);
  const [status, setStatus] = useState<
    'resolving' | 'creating' | 'unassigned' | 'retired' | 'unknown' | 'error'
  >('resolving');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolveOut | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const r = await api.get<ResolveOut>(`/qr/${qrToken}/resolve`);
        if (cancelled) return;
        setResolved(r);
        if (r.state === 'retired') {
          setStatus('retired');
          return;
        }
        if (r.state === 'unassigned') {
          setStatus('unassigned');
          return;
        }

        // Bound sticker. Stash the pair so the auth flow can pick it
        // up after sign-in and we don't lose the context on a
        // navigation.
        if (r.restaurant_id && r.table_code) {
          sessionStorage.setItem(
            'qr-context',
            JSON.stringify({
              restaurantId: r.restaurant_id,
              tableCode: r.table_code,
            }),
          );
        }

        // If the diner is already signed in, create the session
        // immediately — no reason to bounce through auth again.
        if (token && r.restaurant_id && r.table_code) {
          setStatus('creating');
          // Cache the resolved restaurant on the auth store so
          // theming picks up the correct brand colour on the
          // capture screens.
          try {
            const rest = await api.get<Restaurant>(
              `/restaurants/${r.restaurant_slug}`,
            );
            setActiveRestaurant(rest);
          } catch {
            /* non-fatal — theming will fall back to defaults */
          }
          const created = await api.post<SessionCreateOut>(
            '/sessions',
            { table_code: r.table_code, restaurant_id: r.restaurant_id },
            token,
          );
          sessionStorage.setItem(
            `nonce-before-${created.session_id}`,
            created.before_capture_nonce,
          );
          if (!cancelled) navigate(`/sessions/${created.session_id}/order`);
          return;
        }

        // Not signed in yet — bounce through onboarding. The saved
        // `qr-context` gets picked up on the far side.
        if (!cancelled) navigate('/onboard-choice');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiException && err.status === 404) {
          setStatus('unknown');
          return;
        }
        setStatus('error');
        setErrorMsg(
          err instanceof ApiException ? err.message : t('qr.error_generic'),
        );
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // We deliberately depend on qrToken + token — the effect must
    // re-run if the auth state changes (e.g., mid-flow login).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrToken, token]);

  return (
    <div className="d-screen flex flex-col min-h-full">
      <div className="px-5 pt-4 pb-2 spread">
        <span className="chip chip-brand">
          <QrCode size={13} />
          {qrToken || '—'}
        </span>
        <LangToggle />
      </div>

      <div className="px-6 flex-1 flex flex-col items-center justify-center gap-4 text-center">
        {(status === 'resolving' || status === 'creating') && (
          <>
            <Loader2 className="animate-spin text-brand" size={28} />
            <p className="text-[14px] text-muted max-w-[36ch]">
              {status === 'resolving'
                ? t('qr.resolving')
                : t('qr.creating_session', {
                    name: resolved?.restaurant_name ?? '',
                    table: resolved?.table_code ?? '',
                  })}
            </p>
          </>
        )}

        {status === 'unassigned' && (
          <StaticCard
            icon={<QrCode size={26} className="text-brand" />}
            title={t('qr.unassigned_title')}
            message={t('qr.unassigned_body')}
          />
        )}

        {status === 'retired' && (
          <StaticCard
            icon={<AlertCircle size={26} className="text-danger" />}
            title={t('qr.retired_title')}
            message={t('qr.retired_body')}
          />
        )}

        {status === 'unknown' && (
          <StaticCard
            icon={<AlertCircle size={26} className="text-muted" />}
            title={t('qr.unknown_title')}
            message={t('qr.unknown_body')}
          />
        )}

        {status === 'error' && (
          <StaticCard
            icon={<AlertCircle size={26} className="text-danger" />}
            title={t('qr.error_title')}
            message={errorMsg ?? t('qr.error_generic')}
          />
        )}

        <Link
          to="/"
          className="text-[12.5px] font-semibold text-brand hover:underline"
        >
          {t('qr.back_home')}
        </Link>
      </div>
    </div>
  );
}

function StaticCard({
  icon,
  title,
  message,
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
}) {
  return (
    <div className="card p-6 flex flex-col items-center gap-3 max-w-[38ch]">
      <div className="w-12 h-12 rounded-md bg-brand-wash flex items-center justify-center">
        {icon}
      </div>
      <div>
        <div className="font-bold text-[16px] text-ink">{title}</div>
        <p className="text-[13px] text-muted mt-1 leading-snug">{message}</p>
      </div>
    </div>
  );
}
