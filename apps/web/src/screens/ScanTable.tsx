import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import type { Restaurant } from '@plate-clean/shared-types';

interface SessionCreateOut {
  session_id: string;
  expires_at: string;
  before_capture_nonce: string;
}

export function ScanTable() {
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
        if (rs[0]) setRestaurantId(rs[0].id);
      })
      .catch(() => setError('Could not load restaurants.'));
  }, []);

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
      else setError('Could not start session.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">Start a meal</h1>
      <p className="text-sm text-slate-600">
        In production this screen scans a QR sticker on your table. For the pilot, pick a restaurant and
        type your table code.
      </p>
      <label className="block">
        <span className="text-sm text-slate-600">Restaurant</span>
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
        <span className="text-sm text-slate-600">Table code</span>
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
        {busy ? 'Starting…' : 'Open a session'}
      </button>
    </section>
  );
}
