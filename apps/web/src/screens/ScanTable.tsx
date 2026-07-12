import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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

  useEffect(() => {
    api
      .get<Restaurant[]>('/restaurants')
      .then((rs) => {
        setRestaurants(rs);
        // If a diner scanned a bound QR sticker before signing in,
        // QrResolve stashed the resolved (restaurant, table) pair
        // in sessionStorage. Auto-select it now so the diner doesn't
        // have to re-pick after finishing auth — one-shot, cleared
        // on read so a subsequent manual scan doesn't reuse stale
        // context.
        try {
          const raw = sessionStorage.getItem('qr-context');
          if (raw) {
            const hint = JSON.parse(raw) as {
              restaurantId: string;
              tableCode: string;
            };
            sessionStorage.removeItem('qr-context');
            const match = rs.find((r) => r.id === hint.restaurantId);
            if (match) {
              setRestaurantId(match.id);
              setTableCode(hint.tableCode);
              return;
            }
          }
        } catch {
          /* ignore malformed / stale JSON */
        }
        if (rs[0]) setRestaurantId(rs[0].id);
      })
      .catch(() => setError(t('scan.load_error')));
  }, [t]);

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
