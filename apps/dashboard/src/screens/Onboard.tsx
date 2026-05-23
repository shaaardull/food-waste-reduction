import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Restaurant } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface OnboardResponse {
  token: string;
  user: { id: string; email: string; role: string; display_name: string | null };
  restaurant: Restaurant;
}

/**
 * Self-service restaurant onboarding (CLAUDE.md §9 Phase 2).
 *
 * A stranger can hit /onboard, sign up as the owner of a new restaurant,
 * and land on the validation queue with everything wired — no platform
 * admin in the loop.
 *
 * On success: store auth + active_restaurant, then deep-link into the
 * existing AdminOnboard wizard at the menu step so the new owner can
 * finish menu/reward/staff setup.
 */
export function Onboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setAuth, setRestaurantId, setActiveRestaurant } = useAuthStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Owner fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdult, setIsAdult] = useState(false);

  // Restaurant fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState('19.06');
  const [longitude, setLongitude] = useState('72.83');
  const [tagline, setTagline] = useState('');
  const [themeColor, setThemeColor] = useState('#0f766e');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const lat = Number(latitude);
      const lng = Number(longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setError(t('onboard.error_bad_coords'));
        setBusy(false);
        return;
      }
      const res = await api.post<OnboardResponse>('/onboard/restaurant', {
        owner: {
          email,
          password,
          display_name: displayName || null,
          is_adult: isAdult,
        },
        restaurant: {
          name,
          slug,
          address,
          latitude: lat,
          longitude: lng,
          theme_primary_color: themeColor,
          tagline: tagline || undefined,
        },
      });
      setAuth(res.user, res.token);
      setRestaurantId(res.restaurant.id);
      setActiveRestaurant(res.restaurant);
      // Drop the new owner into the existing AdminOnboard wizard so
      // they can add menu items + reward rule + invite more staff.
      navigate(`/onboard/${res.restaurant.id}/setup`);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError(t('onboard.error_generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-2xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('onboard.title')}</h1>
        <p className="text-sm text-slate-600">{t('onboard.blurb')}</p>
      </header>

      <form onSubmit={submit} className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-slate-700">
            {t('onboard.owner_section')}
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t('onboard.email_label')}>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                autoComplete="email"
              />
            </Field>
            <Field label={t('onboard.password_label')}>
              <input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                autoComplete="new-password"
                minLength={8}
              />
            </Field>
          </div>
          <Field label={t('onboard.display_name_label')}>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="input"
              autoComplete="name"
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              required
              checked={isAdult}
              onChange={(e) => setIsAdult(e.target.checked)}
              className="mt-0.5"
            />
            <span>{t('onboard.age_confirm')}</span>
          </label>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-slate-700">
            {t('onboard.restaurant_section')}
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t('onboard.name_label')}>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
                maxLength={120}
              />
            </Field>
            <Field
              label={t('onboard.slug_label')}
              hint={t('onboard.slug_hint')}
            >
              <input
                required
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                pattern="[a-z0-9-]+"
                className="input font-mono"
                placeholder="my-restaurant"
              />
            </Field>
          </div>
          <Field label={t('onboard.address_label')}>
            <input
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="input"
              maxLength={400}
            />
          </Field>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label={t('onboard.latitude_label')}>
              <input
                required
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                className="input"
                inputMode="decimal"
              />
            </Field>
            <Field label={t('onboard.longitude_label')}>
              <input
                required
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                className="input"
                inputMode="decimal"
              />
            </Field>
            <Field label={t('onboard.theme_color_label')}>
              <input
                type="color"
                value={themeColor}
                onChange={(e) => setThemeColor(e.target.value)}
                className="h-10 w-full rounded-md border border-slate-300"
              />
            </Field>
          </div>
          <Field label={t('onboard.tagline_label')}>
            <input
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              className="input"
              maxLength={200}
              placeholder={t('onboard.tagline_placeholder') ?? undefined}
            />
          </Field>
        </section>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 font-medium disabled:opacity-50"
          >
            {busy ? t('onboard.creating') : t('onboard.submit')}
          </button>
          <Link to="/login" className="text-sm text-brand-700 hover:underline">
            {t('onboard.have_account')}
          </Link>
        </div>
      </form>
    </section>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-600">{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
