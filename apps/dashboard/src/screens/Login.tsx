import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Building2, Lock, Mail } from 'lucide-react';
import type { Restaurant } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * Staff sign-in. Picks the restaurant on the same screen so the rail
 * has a context to render against the moment the user lands.
 */
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
      if ((err as ApiException).message) setError((err as ApiException).message);
      else setError(t('login.generic_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-md mx-auto pt-8 flex flex-col gap-5">
      <header className="text-center">
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.name_staff')}
        </div>
        <h1 className="display text-[32px] text-s-ink leading-tight mt-1">
          {t('login.title')}
        </h1>
      </header>

      <form
        onSubmit={submit}
        className="bg-s-paper border border-s-line rounded-lg p-5 flex flex-col gap-4"
      >
        <FormField icon={<Mail size={14} />} label={t('login.email')}>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            autoComplete="email"
          />
        </FormField>
        <FormField icon={<Lock size={14} />} label={t('login.password')}>
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            autoComplete="current-password"
          />
          <div className="text-right mt-1">
            <Link
              to="/forgot-password"
              className="text-[12px] font-semibold text-brand hover:underline"
            >
              {t('login.forgot_password')}
            </Link>
          </div>
        </FormField>
        <FormField icon={<Building2 size={14} />} label={t('login.restaurant')}>
          <select
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            className="input"
          >
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </FormField>
        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary btn-block min-h-[48px]"
        >
          {busy ? t('login.working') : t('login.submit')}
        </button>
      </form>

      <p className="text-sm text-s-muted text-center pt-1">
        <Trans
          i18nKey="login.onboard_link"
          components={{
            l: (
              <Link
                to="/onboard"
                className="text-brand font-semibold hover:underline"
              />
            ),
          }}
        />
      </p>
    </section>
  );
}

interface FieldProps {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}

function FormField({ icon, label, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="row gap-1.5 items-center text-[12.5px] font-semibold text-s-ink">
        <span className="text-s-muted">{icon}</span>
        {label}
      </span>
      {children}
    </label>
  );
}
