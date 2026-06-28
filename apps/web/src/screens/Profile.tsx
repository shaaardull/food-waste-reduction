import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Leaf,
  Sparkles,
  Languages,
  Camera,
  Check,
  LogOut,
  Trash2,
  Mail,
  Shield,
} from 'lucide-react';
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

/**
 * Profile screen — diner's settings home.
 *
 * Order of sections mirrors what matters most to the diner:
 *   1. their impact (sustainability card — sage, hero)
 *   2. account chip (email + role at a glance)
 *   3. language (.chip-style picker)
 *   4. photo retention (ethics rule 6 — 7-day default, 90-day opt-in)
 *   5. account exits (sign out, delete)
 */
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

  if (!user) {
    return (
      <div className="d-screen min-h-full px-5 py-12">
        <p className="text-muted text-sm">{t('profile.sign_in_first')}</p>
      </div>
    );
  }

  const currentLang = (i18n.resolvedLanguage ?? 'en') as Language;
  const retentionDays = user.image_retention_days ?? 7;

  return (
    <div className="d-screen flex flex-col min-h-full">
      <div className="px-5 pt-4 pb-2">
        <h1 className="display text-[26px]">{t('profile.title')}</h1>
      </div>

      <div className="px-4 pb-8 flex flex-col gap-4">
        <SustainabilityCard token={token} />

        {/* Account chip */}
        <div className="card p-4 flex flex-col gap-2.5">
          <div className="row gap-2.5 items-center">
            <div className="w-9 h-9 rounded-md bg-brand-wash text-brand flex items-center justify-center">
              <Mail size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-muted dev">
                {t('profile.email_label')}
              </div>
              <div className="font-semibold text-[15px] truncate">
                {user.email}
              </div>
            </div>
          </div>
          <div className="row gap-2.5 items-center">
            <div className="w-9 h-9 rounded-md bg-brand-wash text-brand flex items-center justify-center">
              <Shield size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-muted dev">
                {t('profile.role_label')}
              </div>
              <div className="font-semibold text-[15px] capitalize">
                {user.role}
              </div>
            </div>
          </div>
        </div>

        {/* Language picker */}
        <div className="card p-4 flex flex-col gap-3">
          <div className="row gap-2 items-center">
            <Languages size={16} className="text-brand" />
            <div className="font-semibold text-[15px]">
              {t('profile.language_label')}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {SUPPORTED_LANGUAGES.map((lang) => {
              const active = currentLang === lang;
              return (
                <button
                  key={lang}
                  onClick={() => void i18n.changeLanguage(lang)}
                  className={`chip transition ${
                    active
                      ? 'bg-brand text-white'
                      : 'bg-paper border border-line text-ink/80 hover:text-ink'
                  }`}
                  aria-pressed={active}
                >
                  {LANGUAGE_LABELS[lang]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Retention */}
        <div className="card p-4 flex flex-col gap-3">
          <div className="row gap-2 items-center">
            <Camera size={16} className="text-brand" />
            <div className="font-semibold text-[15px]">
              {t('profile.retention_label')}
            </div>
          </div>
          <p className="text-[13px] text-muted leading-snug">
            {t('profile.retention_blurb')}
          </p>
          <div className="flex flex-col gap-2">
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
            <div className="row gap-2 items-center text-[12.5px] text-sage font-semibold">
              <Check size={14} />
              <span>{t('profile.retention_saved')}</span>
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {/* Exits */}
        <div className="flex flex-col gap-2.5">
          <button
            onClick={signOut}
            className="btn btn-outline btn-block min-h-[48px]"
          >
            <LogOut size={16} />
            {t('profile.sign_out')}
          </button>
          <button
            onClick={deleteAccount}
            disabled={busy}
            className="btn btn-block min-h-[48px] bg-paper border border-danger/30 text-danger hover:bg-danger-wash disabled:opacity-50"
          >
            <Trash2 size={16} />
            {t('profile.delete_account')}
          </button>
          <p className="text-[12px] text-muted leading-snug text-center mt-1">
            {t('profile.delete_blurb')}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ----- pieces ----------------------------------------------------- */

interface RetentionOptionProps {
  label: string;
  caption: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}

function RetentionOption({
  label,
  caption,
  active,
  disabled,
  onClick,
}: RetentionOptionProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left card-flat p-3 transition ${
        active
          ? 'border-brand ring-2 ring-brand/15 bg-brand-wash'
          : 'hover:border-brand'
      } disabled:opacity-60`}
    >
      <div className="spread">
        <div className="font-semibold text-[14px]">{label}</div>
        {active && (
          <span className="w-4 h-4 rounded-full bg-brand text-white flex items-center justify-center">
            <Check size={11} />
          </span>
        )}
      </div>
      <div className="text-[12.5px] text-muted mt-0.5">{caption}</div>
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
      <div className="card p-4 flex flex-col gap-1.5">
        <div className="row gap-2 items-center">
          <Leaf size={16} className="text-sage" />
          <div className="font-semibold text-[15px]">
            {t('profile.sustainability_heading')}
          </div>
        </div>
        <p className="text-[12.5px] text-muted">
          {t('profile.sustainability_loading')}
        </p>
      </div>
    );
  }
  if (!data) return null;

  const empty = data.sessions_counted === 0 || data.kg_food_saved === 0;
  if (empty) {
    return (
      <div className="card p-4 flex flex-col gap-1.5">
        <div className="row gap-2 items-center">
          <Leaf size={16} className="text-sage" />
          <div className="font-semibold text-[15px]">
            {t('profile.sustainability_heading')}
          </div>
        </div>
        <p className="text-[12.5px] text-muted">
          {t('profile.sustainability_empty')}
        </p>
      </div>
    );
  }

  const sessionsText =
    data.sessions_counted === 1
      ? t('profile.sustainability_sessions_counted', { count: 1 })
      : t('profile.sustainability_sessions_counted_plural', {
          count: data.sessions_counted,
        });

  return (
    <div className="card p-5 flex flex-col gap-4 bg-sage-wash/40 border-sage/20">
      <div className="row gap-2.5 items-center">
        <div className="w-10 h-10 rounded-md bg-sage-wash text-sage flex items-center justify-center">
          <Leaf size={18} />
        </div>
        <div className="font-semibold text-[15px] text-sage">
          {t('profile.sustainability_heading')}
        </div>
      </div>
      {/* hero number */}
      <div>
        <div className="tnum font-bold text-[40px] leading-none text-ink">
          {data.kg_food_saved.toFixed(2)}
        </div>
        <div className="text-[13px] text-muted mt-1">
          {t('profile.sustainability_food_saved')}
        </div>
      </div>
      {/* sub-stats */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-md bg-paper border border-line p-3">
          <div className="tnum font-bold text-[20px] text-ink">
            {data.kg_co2e_saved.toFixed(2)}
          </div>
          <div className="text-[11.5px] text-muted dev mt-1 leading-tight">
            {t('profile.sustainability_co2e_saved')}
          </div>
        </div>
        <div className="rounded-md bg-paper border border-line p-3">
          <div className="row gap-1.5 items-baseline">
            <Sparkles size={14} className="text-saffron-deep" />
            <div className="tnum font-bold text-[20px] text-ink">
              {data.trees_day_equivalent.toFixed(1)}
            </div>
          </div>
          <div className="text-[11.5px] text-muted dev mt-1 leading-tight">
            {t('profile.sustainability_trees_caption')}
          </div>
        </div>
      </div>
      <p className="text-[12px] text-muted leading-snug">
        {sessionsText} · {t('profile.sustainability_blurb')}
      </p>
    </div>
  );
}
