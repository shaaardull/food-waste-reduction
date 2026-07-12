import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { User } from '@plate-clean/shared-types';
import { ArrowLeft, Zap } from 'lucide-react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LangToggle } from '../components/LangToggle';
import { GoogleSignInButton } from '../components/GoogleSignInButton';

type Mode = 'sign-in' | 'sign-up';

/**
 * Sign-in / sign-up for repeat diners. Front-door screen (no App header)
 * so it carries its own back link + language toggle. New diners are
 * pushed toward /quick-start (phone OTP, no account) — this screen
 * exists for people who already created an email account.
 */
export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdult, setIsAdult] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path = mode === 'sign-in' ? '/auth/login' : '/auth/register';
      // Dual-channel sign-up: phone + email both go through /auth/register
      // so every account has both delivery lanes (bills → email, OTP +
      // reset codes → phone). Sign-in stays email + password.
      const payload =
        mode === 'sign-in'
          ? { email, password }
          : {
              email,
              phone: phone.trim(),
              password,
              display_name: displayName,
              is_adult: isAdult,
            };
      const res = await api.post<{ user: User; token: string }>(path, payload);
      setAuth(res.user, res.token);
      navigate('/scan');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError(t('login.generic_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="d-screen min-h-full">
      <div className="px-5 pt-4 spread">
        <Link
          to="/"
          className="btn-tertiary !min-h-0 !p-1 inline-flex items-center gap-1.5"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </Link>
        <LangToggle />
      </div>

      <div className="max-w-md mx-auto px-5 pt-6 pb-10 space-y-5">
        <header className="space-y-1">
          <div className="eyebrow text-brand">
            {mode === 'sign-in' ? t('login.welcome_back') : t('login.create_account')}
          </div>
          <h1 className="display text-[34px] text-ink leading-tight">
            {mode === 'sign-in'
              ? t('login.welcome_back')
              : t('login.create_account')}
          </h1>
        </header>

        {/* Google Identity Services sits above the email form — it's
            the fastest path for the ~90% of diners who already have
            a Gmail account, and dropping it below the form buries a
            major conversion lever. The "or continue with email"
            divider makes it clear both paths exist. */}
        <div className="flex flex-col gap-3">
          <GoogleSignInButton redirectTo="/scan" />
          <div className="row gap-2 items-center text-[11px] text-muted uppercase tracking-wide dev">
            <span className="flex-1 h-px bg-line" />
            <span>{t('login.or_with_email')}</span>
            <span className="flex-1 h-px bg-line" />
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3.5">
          <Field label={t('login.email')}>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              autoComplete="email"
            />
          </Field>

          {mode === 'sign-up' && (
            <>
              <Field label={t('login.phone')}>
                <input
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="input"
                  autoComplete="tel"
                  inputMode="tel"
                />
                <span className="text-[11.5px] text-faint mt-1 block">
                  {t('login.phone_hint')}
                </span>
              </Field>
              <Field label={t('login.display_name')}>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="input"
                  autoComplete="name"
                />
              </Field>
            </>
          )}

          <Field label={t('login.password')}>
            <input
              required
              type="password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            />
            {mode === 'sign-in' && (
              <div className="text-right mt-1">
                <Link
                  to="/forgot-password"
                  className="text-[12.5px] font-semibold text-brand hover:underline"
                >
                  {t('login.forgot_password')}
                </Link>
              </div>
            )}
          </Field>

          {mode === 'sign-up' && (
            <label className="flex items-start gap-2 text-sm text-muted">
              <input
                type="checkbox"
                required
                checked={isAdult}
                onChange={(e) => setIsAdult(e.target.checked)}
                className="mt-1"
              />
              <span>{t('login.age_confirm')}</span>
            </label>
          )}

          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary btn-lg btn-block disabled:opacity-50"
          >
            {busy
              ? t('login.working')
              : mode === 'sign-in'
                ? t('login.submit_sign_in')
                : t('login.submit_create')}
          </button>
        </form>

        <div className="text-center space-y-3 pt-2 border-t border-line">
          <button
            onClick={() =>
              setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
            }
            className="btn-tertiary block w-full"
          >
            <span className="text-brand">
              {mode === 'sign-in'
                ? t('login.switch_to_sign_up')
                : t('login.switch_to_sign_in')}
            </span>
          </button>
          <Link
            to="/quick-start"
            className="btn-ghost inline-flex items-center gap-2 text-sm"
          >
            <Zap size={16} /> {t('landing.quick_start')}
          </Link>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted font-medium">{label}</span>
      {children}
    </label>
  );
}
