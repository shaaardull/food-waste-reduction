import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { User } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from '../lib/i18n';

interface SustainabilityReport {
  period_days: number;
  sessions_counted: number;
  kg_food_saved: number;
  kg_co2e_saved: number;
  trees_day_equivalent: number;
}

export function Profile() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, token, setAuth, clearAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retentionBusy, setRetentionBusy] = useState(false);

  async function signOut() {
    try {
      await api.post('/auth/logout', undefined, token);
    } catch {
      /* ignore */
    }
    clearAuth();
    navigate('/');
  }

  async function deleteAccount() {
    if (!confirm(t('profile.delete_confirm'))) return;
    setBusy(true);
    setError(null);
    try {
      await api.del('/auth/me', token);
      clearAuth();
      navigate('/');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      setBusy(false);
    }
  }

  async function setRetention(days: 7 | 90) {
    if (!user || !token) return;
    if (user.image_retention_days === days) return;
    setRetentionBusy(true);
    setError(null);
    try {
      const updated = await api.patch<User>(
        '/auth/me',
        { image_retention_days: days },
        token,
      );
      // Keep the auth store user in sync so other screens see the change.
      setAuth(updated, token);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2_000);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError(t('profile.retention_error'));
    } finally {
      setRetentionBusy(false);
    }
  }

  if (!user) return <p className="text-slate-600">{t('profile.sign_in_first')}</p>;

  const currentLang = (i18n.resolvedLanguage ?? 'en') as Language;
  const retentionDays = user.image_retention_days ?? 7;

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">{t('profile.title')}</h1>
      <div className="rounded-lg border border-slate-200 p-3 text-sm">
        <p>
          <span className="text-slate-500">{t('profile.email_label')}:</span> {user.email}
        </p>
        <p>
          <span className="text-slate-500">{t('profile.role_label')}:</span> {user.role}
        </p>
      </div>

      <SustainabilityCard token={token} />

      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <p className="text-sm text-slate-600">{t('profile.language_label')}</p>
        <div className="flex gap-2 flex-wrap">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang}
              onClick={() => void i18n.changeLanguage(lang)}
              className={`rounded-full px-3 py-1 text-sm border ${
                currentLang === lang
                  ? 'bg-brand-700 text-white border-brand-700'
                  : 'border-slate-300 text-slate-700'
              }`}
            >
              {LANGUAGE_LABELS[lang]}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 p-3 space-y-3">
        <header className="space-y-1">
          <p className="text-sm font-medium">{t('profile.retention_label')}</p>
          <p className="text-xs text-slate-600">{t('profile.retention_blurb')}</p>
        </header>
        <div className="grid gap-2">
          <RetentionOption
            label={t('profile.retention_7_label')}
            caption={t('profile.retention_7_caption')}
            active={retentionDays === 7}
            disabled={retentionBusy}
            onClick={() => void setRetention(7)}
          />
          <RetentionOption
            label={t('profile.retention_90_label')}
            caption={t('profile.retention_90_caption')}
            active={retentionDays === 90}
            disabled={retentionBusy}
            onClick={() => void setRetention(90)}
          />
        </div>
        {savedNotice && (
          <p className="text-xs text-brand-700">{t('profile.retention_saved')}</p>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <button onClick={signOut} className="w-full rounded-md border border-slate-300 py-2">
        {t('profile.sign_out')}
      </button>
      <button
        onClick={deleteAccount}
        disabled={busy}
        className="w-full rounded-md border border-red-300 text-red-700 py-2 disabled:opacity-50"
      >
        {t('profile.delete_account')}
      </button>
      <p className="text-xs text-slate-500">{t('profile.delete_blurb')}</p>
    </section>
  );
}

interface RetentionOptionProps {
  label: string;
  caption: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}

function RetentionOption({ label, caption, active, disabled, onClick }: RetentionOptionProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-lg border p-3 transition ${
        active
          ? 'border-brand-600 bg-brand-50'
          : 'border-slate-200 hover:border-brand-600'
      } disabled:opacity-60`}
    >
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">{label}</div>
        {active && <span className="text-xs text-brand-700">●</span>}
      </div>
      <div className="text-xs text-slate-500">{caption}</div>
    </button>
  );
}

function SustainabilityCard({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['sustainability'],
    queryFn: () =>
      api.get<SustainabilityReport>('/auth/me/sustainability?days=30', token),
    enabled: Boolean(token),
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <p className="text-sm font-medium">{t('profile.sustainability_heading')}</p>
        <p className="text-xs text-slate-500">{t('profile.sustainability_loading')}</p>
      </div>
    );
  }
  if (!data) return null;

  const empty = data.sessions_counted === 0 || data.kg_food_saved === 0;
  if (empty) {
    return (
      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <p className="text-sm font-medium">{t('profile.sustainability_heading')}</p>
        <p className="text-xs text-slate-500">{t('profile.sustainability_empty')}</p>
      </div>
    );
  }

  const sessionsText =
    data.sessions_counted === 1
      ? t('profile.sustainability_sessions_counted', { count: 1 })
      : t('profile.sustainability_sessions_counted_plural', { count: data.sessions_counted });

  return (
    <div className="rounded-lg border-2 border-brand-600/40 bg-brand-50 p-4 space-y-3">
      <p className="text-sm font-medium text-brand-700">
        {t('profile.sustainability_heading')}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Stat
          value={data.kg_food_saved.toFixed(2)}
          label={t('profile.sustainability_food_saved')}
        />
        <Stat
          value={data.kg_co2e_saved.toFixed(2)}
          label={t('profile.sustainability_co2e_saved')}
        />
      </div>
      <p className="text-xs text-slate-600">
        {t('profile.sustainability_trees_day', {
          value: data.trees_day_equivalent.toFixed(1),
        })}{' '}
        &middot; {sessionsText}
      </p>
      <p className="text-xs text-slate-500">{t('profile.sustainability_blurb')}</p>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-md bg-white border border-slate-200 p-3">
      <div className="text-2xl font-semibold text-brand-700">{value}</div>
      <div className="text-xs text-slate-600 mt-1">{label}</div>
    </div>
  );
}
