import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import type { Restaurant } from '@plate-clean/shared-types';

interface SessionCreateOut {
  session_id: string;
  expires_at: string;
  before_capture_nonce: string;
}

export function ScanTable() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const setActiveRestaurant = useAuthStore((s) => s.setActiveRestaurant);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState<string>('');
  const [tableCode, setTableCode] = useState('T-01');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Fast-path when we arrive here from QrResolve → auth → back here
  // with a stashed (restaurant, table) pair. Skip the picker entirely
  // and drop the diner into the menu.
  const [resuming, setResuming] = useState(
    () => typeof window !== 'undefined' && !!sessionStorage.getItem('qr-context'),
  );

  useEffect(() => {
    let cancelled = false;

    async function loadAndMaybeResume() {
      let rs: Restaurant[] = [];
      try {
        rs = await api.get<Restaurant[]>('/restaurants');
        if (cancelled) return;
        setRestaurants(rs);
      } catch {
        if (!cancelled) {
          setError(t('scan.load_error'));
          setResuming(false);
        }
        return;
      }

      // If a diner scanned a bound QR sticker before signing in,
      // QrResolve stashed the resolved (restaurant, table) pair
      // in sessionStorage. Auto-create the session and go straight
      // to the menu — one-shot, cleared on read.
      let hint: { restaurantId: string; tableCode: string } | null = null;
      try {
        const raw = sessionStorage.getItem('qr-context');
        if (raw) {
          hint = JSON.parse(raw);
          sessionStorage.removeItem('qr-context');
        }
      } catch {
        /* ignore malformed / stale JSON */
      }

      const match = hint ? rs.find((r) => r.id === hint!.restaurantId) : null;
      if (hint && match && token) {
        try {
          setActiveRestaurant(match);
          const created = await api.post<SessionCreateOut>(
            '/sessions',
            { table_code: hint.tableCode, restaurant_id: match.id },
            token,
          );
          if (cancelled) return;
          sessionStorage.setItem(
            `nonce-before-${created.session_id}`,
            created.before_capture_nonce,
          );
          navigate(`/sessions/${created.session_id}/order`, { replace: true });
          return;
        } catch (err) {
          // Auto-resume failed — fall through to the picker with the
          // hint pre-filled so the diner can retry manually.
          if (!cancelled) {
            setRestaurantId(match.id);
            setTableCode(hint.tableCode);
            setError(err instanceof ApiException ? err.message : t('scan.start_error'));
            setResuming(false);
          }
          return;
        }
      }

      // No hint (or restaurant no longer exists / not signed in yet) —
      // render the normal picker with the first restaurant selected.
      if (cancelled) return;
      if (rs[0]) setRestaurantId(rs[0].id);
      setResuming(false);
    }

    void loadAndMaybeResume();
    return () => {
      cancelled = true;
    };
  }, [t, token, navigate, setActiveRestaurant]);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const chosen = restaurants.find((r) => r.id === restaurantId) ?? null;
      setActiveRestaurant(chosen);
      const res = await api.post<SessionCreateOut>(
        '/sessions',
        { table_code: tableCode, restaurant_id: restaurantId },
        token,
      );
      sessionStorage.setItem(`nonce-before-${res.session_id}`, res.before_capture_nonce);
      navigate(`/sessions/${res.session_id}/order`);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError(t('scan.start_error'));
    } finally {
      setBusy(false);
    }
  }

  if (resuming) {
    return (
      <section className="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <Loader2 className="animate-spin text-brand" size={28} />
        <p className="text-sm text-slate-600">{t('scan.resuming')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">{t('scan.title')}</h1>
      <p className="text-sm text-slate-600">{t('scan.blurb')}</p>
      <label className="block">
        <span className="text-sm text-slate-600">{t('scan.restaurant_label')}</span>
        <select
          value={restaurantId}
          onChange={(e) => setRestaurantId(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        >
          {restaurants.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-slate-600">{t('scan.table_code_label')}</span>
        <input
          value={tableCode}
          onChange={(e) => setTableCode(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        onClick={start}
        disabled={busy || !restaurantId}
        className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white py-2 font-medium disabled:opacity-50"
      >
        {busy ? t('scan.starting') : t('scan.start')}
      </button>
    </section>
  );
}
