import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Restaurant } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setAuth, setRestaurantId, setActiveRestaurant } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Restaurant[]>('/restaurants')
      .then((rs) => {
        setRestaurants(rs);
        if (rs[0]) setChosen(rs[0].id);
      })
      .catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        user: { id: string; email: string; role: string; display_name: string | null };
        token: string;
      }>('/auth/login', { email, password });
      if (!['staff', 'admin'].includes(res.user.role)) {
        setError(t('login.non_staff_error'));
        setBusy(false);
        return;
      }
      setAuth(res.user, res.token);
      if (chosen) {
        setRestaurantId(chosen);
        const chosenRestaurant = restaurants.find((r) => r.id === chosen) ?? null;
        setActiveRestaurant(chosenRestaurant);
      }
      navigate('/validations');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError(t('login.generic_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-md mx-auto space-y-4">
      <h1 className="text-xl font-semibold">{t('login.title')}</h1>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm text-slate-600">{t('login.email')}</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-600">{t('login.password')}</span>
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-600">{t('login.restaurant')}</span>
          <select
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          >
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white py-2 font-medium disabled:opacity-50"
        >
          {busy ? t('login.working') : t('login.submit')}
        </button>
      </form>
    </section>
  );
}
