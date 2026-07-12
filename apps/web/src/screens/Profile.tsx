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
  Lock,
  AlertCircle,
  ChevronDown,
} from 'lucide-react';
import { clsx } from 'clsx';
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

        {/* Change password */}
        <ChangePasswordCard token={token} />

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

        {/* Disputes filed by this diner — open + resolved. */}
        <MyDisputesCard token={token} />

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

/**
 * ChangePasswordCard — signed-in password rotation surface.
 *
 * Kept collapsed by default because most sessions won't touch it —
 * a "Change password" chip that expands into the three-field form
 * (current, new, confirm) when tapped. The expand-in-place pattern
 * avoids a full-screen modal for what should feel like a settings
 * tweak.
 *
 * Client-side "confirm matches new" check runs before the API call
 * so we don't waste an /auth/change-password round-trip on a typo.
 */
function ChangePasswordCard({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError(t('profile.password_too_short'));
      return;
    }
    if (next !== confirm) {
      setError(t('profile.password_mismatch'));
      return;
    }
    if (next === current) {
      setError(t('profile.password_same'));
      return;
    }
    setBusy(true);
    try {
      await api.post(
        '/auth/change-password',
        { current_password: current, new_password: next },
        token,
      );
      reset();
      setSaved(true);
      setOpen(false);
      setTimeout(() => setSaved(false), 2_400);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError(t('profile.password_error_generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="row spread gap-2 items-center">
        <div className="row gap-2 items-center">
          <Lock size={16} className="text-brand" />
          <div className="font-semibold text-[15px]">
            {t('profile.password_label')}
          </div>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => {
              reset();
              setOpen(true);
            }}
            className="text-[12.5px] font-semibold text-brand hover:underline"
          >
            {t('profile.password_change')}
          </button>
        )}
      </div>

      {!open && (
        <p className="text-[12.5px] text-muted leading-snug">
          {saved
            ? t('profile.password_saved')
            : t('profile.password_blurb')}
        </p>
      )}

      {open && (
        <form onSubmit={submit} className="flex flex-col gap-2.5">
          <label className="block">
            <span className="text-xs text-muted font-medium">
              {t('profile.password_current')}
            </span>
            <input
              required
              type="password"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="input"
              autoComplete="current-password"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted font-medium">
              {t('profile.password_new')}
            </span>
            <input
              required
              type="password"
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="input"
              autoComplete="new-password"
            />
            <span className="text-[11.5px] text-faint mt-1 block">
              {t('profile.password_new_hint')}
            </span>
          </label>
          <label className="block">
            <span className="text-xs text-muted font-medium">
              {t('profile.password_confirm')}
            </span>
            <input
              required
              type="password"
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="input"
              autoComplete="new-password"
            />
          </label>

          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <div className="row gap-2 mt-1">
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className="btn btn-outline flex-1 min-h-[42px] text-[13.5px]"
            >
              {t('profile.password_cancel')}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary flex-1 min-h-[42px] text-[13.5px] disabled:opacity-50"
            >
              {busy ? t('profile.password_saving') : t('profile.password_submit')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * MyDisputesCard — the diner's own dispute history.
 *
 * Ethics rule 9 (diner recourse) says a diner can raise a dispute
 * and the owner (or platform support) has to respond. This card
 * closes the loop by showing them WHAT they filed and HOW it was
 * resolved. Open disputes float to the top with an amber chip;
 * resolved rows are collapsed under a toggle to keep the profile
 * quiet for a diner who has filed many over time.
 */
interface MyDispute {
  id: string;
  meal_session_id: string;
  table_code: string;
  restaurant_name: string;
  reason: string;
  status:
    | 'open'
    | 'resolved_in_favor_diner'
    | 'resolved_in_favor_restaurant'
    | 'closed';
  created_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
}

function MyDisputesCard({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['my-disputes'],
    queryFn: () => api.get<MyDispute[]>('/auth/me/disputes', token),
    enabled: Boolean(token),
  });

  // Card is hidden entirely when the diner has never filed a dispute
  // — no signal, no noise. Only appears once there's history to show.
  if (isLoading || !data || data.length === 0) return null;

  const open = data.filter((d) => d.status === 'open');
  const resolved = data.filter((d) => d.status !== 'open');

  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="row gap-2 items-center">
        <AlertCircle size={16} className="text-brand" />
        <div className="font-semibold text-[15px]">
          {t('profile.disputes_label')}
        </div>
      </div>
      <p className="text-[12.5px] text-muted leading-snug">
        {t('profile.disputes_blurb')}
      </p>

      {open.length > 0 && (
        <ul className="flex flex-col gap-2">
          {open.map((d) => (
            <DisputeRow key={d.id} dispute={d} />
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setResolvedOpen((v) => !v)}
            className="row spread items-center border border-line rounded-md px-3 py-2 hover:border-brand transition"
            aria-expanded={resolvedOpen}
          >
            <span className="font-semibold text-[13px] text-ink">
              {t('profile.disputes_resolved_toggle', {
                count: resolved.length,
              })}
            </span>
            <ChevronDown
              size={14}
              className={clsx(
                'transition-transform text-muted',
                resolvedOpen && 'rotate-180',
              )}
            />
          </button>
          {resolvedOpen && (
            <ul className="flex flex-col gap-2">
              {resolved.map((d) => (
                <DisputeRow key={d.id} dispute={d} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function DisputeRow({ dispute: d }: { dispute: MyDispute }) {
  const { t } = useTranslation();
  const filed = new Date(d.created_at);
  const resolved = d.resolved_at ? new Date(d.resolved_at) : null;
  return (
    <li className="rounded-md border border-line bg-paper p-3 flex flex-col gap-1.5">
      <div className="row spread items-start gap-2">
        <div className="flex flex-col min-w-0">
          <div className="text-[12.5px] text-muted dev">
            {t('profile.disputes_row_meta', {
              restaurant: d.restaurant_name,
              table: d.table_code,
              date: filed.toLocaleDateString(),
            })}
          </div>
          <div className="text-[13.5px] text-ink font-semibold leading-snug mt-0.5 line-clamp-3">
            {d.reason}
          </div>
        </div>
        <StatusChip status={d.status} />
      </div>
      {resolved && (
        <div className="text-[12px] text-muted leading-snug">
          {t('profile.disputes_resolved_at', {
            date: resolved.toLocaleDateString(),
          })}
        </div>
      )}
      {d.resolution_notes && (
        <div className="text-[12px] text-ink leading-snug bg-cream rounded px-2.5 py-1.5">
          <span className="font-semibold">
            {t('profile.disputes_owner_notes')}
          </span>{' '}
          {d.resolution_notes}
        </div>
      )}
    </li>
  );
}

function StatusChip({ status }: { status: MyDispute['status'] }) {
  const { t } = useTranslation();
  const cls =
    status === 'open'
      ? 'chip-amber'
      : status === 'resolved_in_favor_diner'
        ? 'chip-brand'
        : status === 'resolved_in_favor_restaurant'
          ? 'chip-muted'
          : 'chip-muted';
  return (
    <span className={`chip ${cls} whitespace-nowrap`}>
      {t(`profile.disputes_status.${status}`)}
    </span>
  );
}
