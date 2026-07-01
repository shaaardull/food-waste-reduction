import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, Building2 } from 'lucide-react';
import type { Restaurant } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
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
      navigate(`/onboard/${res.restaurant.id}/setup`);
    } catch (err) {
      if ((err as ApiException).message) setError((err as ApiException).message);
      else setError(t('onboard.error_generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-2xl mx-auto flex flex-col gap-6 pt-2">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.name_staff')}
        </div>
        <h1 className="display text-[32px] text-s-ink leading-tight">
          {t('onboard.title')}
        </h1>
        <p className="text-[13px] text-s-muted mt-1.5">{t('onboard.blurb')}</p>
      </header>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormCard icon={<User size={16} />} title={t('onboard.owner_section')}>
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
          <label className="row gap-2 items-start text-[13px] text-s-ink">
            <input
              type="checkbox"
              required
              checked={isAdult}
              onChange={(e) => setIsAdult(e.target.checked)}
              className="mt-0.5 accent-brand"
            />
            <span>{t('onboard.age_confirm')}</span>
          </label>
        </FormCard>

        <FormCard icon={<Building2 size={16} />} title={t('onboard.restaurant_section')}>
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
            <Field label={t('onboard.slug_label')} hint={t('onboard.slug_hint')}>
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
                className="h-10 w-full rounded-md border border-s-line"
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
        </FormCard>

        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        <div className="row gap-3 items-center flex-wrap">
          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary min-h-[48px] px-5 disabled:opacity-50"
          >
            {busy ? t('onboard.creating') : t('onboard.submit')}
          </button>
          <Link
            to="/login"
            className="text-[13px] text-brand font-semibold hover:underline"
          >
            {t('onboard.have_account')}
          </Link>
        </div>
      </form>
    </section>
  );
}

/* ----- pieces ----------------------------------------------------- */

interface FormCardProps {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}

function FormCard({ icon, title, children }: FormCardProps) {
  return (
    <section className="bg-s-paper border border-s-line rounded-lg p-4 flex flex-col gap-3">
      <div className="row gap-2 items-center text-s-muted">
        {icon}
        <span className="font-semibold text-[12px] dev uppercase tracking-wide">
          {title}
        </span>
      </div>
      {children}
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
    <label className="block">
      <span className="text-[12.5px] font-semibold text-s-ink">{label}</span>
      {children}
      {hint && (
        <span className="block text-[11.5px] text-s-muted mt-1">{hint}</span>
      )}
    </label>
  );
}
