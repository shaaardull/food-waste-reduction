import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Lock, Mail } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * Staff-side forgot-password. Mirrors the diner PWA flow — same
 * two-step (identifier → OTP + new password) shape and same backend
 * endpoints, since /auth/forgot-password + /auth/reset-password are
 * role-agnostic. Staff can enter their email or the phone they signed
 * up with; the OTP arrives via SMS.
 *
 * On success we drop the staff back at /login (not straight into the
 * dashboard) so they can pick the restaurant context — the reset
 * endpoint issues a token, but the auth store also needs
 * activeRestaurant which Login populates.
 */
const OTP_LENGTH = 6;

type Step = 'identifier' | 'reset';

export function ForgotPassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [step, setStep] = useState<Step>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const boxRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (step === 'reset') queueMicrotask(() => boxRefs.current[0]?.focus());
  }, [step]);

  const code = digits.join('');

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ request_id: string; delivery: string }>(
        '/auth/forgot-password',
        { identifier: identifier.trim() },
      );
      setRequestId(res.request_id);
      setDigits(Array(OTP_LENGTH).fill(''));
      setStep('reset');
    } catch (err) {
      setError(
        (err as ApiException).message ?? t('forgot_password.error_generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !requestId) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{
        user: { id: string; email: string; role: string; display_name: string | null };
        token: string;
      }>('/auth/reset-password', {
        request_id: requestId,
        code,
        new_password: newPassword,
      });
      // Even though the reset endpoint returns a token, the staff shell
      // needs an activeRestaurant to render — send them back to /login
      // to pick that. We do set the auth so the redirect feels
      // "authenticated" for the interstitial success screen.
      setAuth(res.user, res.token);
      setDone(true);
      setTimeout(() => navigate('/login'), 1600);
    } catch (err) {
      setError(
        (err as ApiException).message ?? t('forgot_password.error_generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  function handleBoxChange(i: number, val: string) {
    const onlyDigits = val.replace(/\D/g, '');
    if (onlyDigits.length > 1) {
      const next = Array(OTP_LENGTH).fill('');
      for (let j = 0; j < OTP_LENGTH; j++) next[j] = onlyDigits[j] ?? '';
      setDigits(next);
      const lastFilled = Math.min(onlyDigits.length, OTP_LENGTH) - 1;
      boxRefs.current[lastFilled]?.focus();
      return;
    }
    const next = [...digits];
    next[i] = onlyDigits.slice(0, 1);
    setDigits(next);
    if (onlyDigits && i < OTP_LENGTH - 1) boxRefs.current[i + 1]?.focus();
  }

  function handleBoxKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      boxRefs.current[i - 1]?.focus();
    }
  }

  if (done) {
    return (
      <section className="max-w-md mx-auto pt-10 flex flex-col items-center gap-3 text-center">
        <div className="w-16 h-16 rounded-full bg-sage-wash text-sage flex items-center justify-center">
          <Check size={30} />
        </div>
        <h1 className="display text-[26px] text-s-ink leading-tight">
          {t('forgot_password.done_title')}
        </h1>
        <p className="text-[13px] text-s-muted max-w-[42ch]">
          {t('forgot_password.done_blurb')}
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-md mx-auto pt-8 flex flex-col gap-5">
      <div className="row spread items-center">
        <Link
          to="/login"
          className="row gap-1.5 items-center text-[13px] font-semibold text-s-muted hover:text-s-ink"
        >
          <ArrowLeft size={14} />
          {t('forgot_password.back')}
        </Link>
      </div>

      <header className="text-center">
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('forgot_password.eyebrow')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight mt-1">
          {step === 'identifier'
            ? t('forgot_password.title')
            : t('forgot_password.reset_title')}
        </h1>
        <p className="text-[13px] text-s-muted mt-2 max-w-[46ch] mx-auto">
          {step === 'identifier'
            ? t('forgot_password.blurb')
            : t('forgot_password.reset_blurb')}
        </p>
      </header>

      {step === 'identifier' ? (
        <form
          onSubmit={requestReset}
          className="bg-s-paper border border-s-line rounded-lg p-5 flex flex-col gap-4"
        >
          <label className="flex flex-col gap-1">
            <span className="row gap-1.5 items-center text-[12.5px] font-semibold text-s-ink">
              <Mail size={14} className="text-s-muted" />
              {t('forgot_password.identifier_label')}
            </span>
            <input
              required
              autoFocus
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="you@example.com · +91 98765 43210"
              className="input"
              autoComplete="email"
            />
            <span className="text-[11.5px] text-s-muted">
              {t('forgot_password.identifier_hint')}
            </span>
          </label>

          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary btn-block min-h-[46px] disabled:opacity-50"
          >
            {busy ? t('forgot_password.sending') : t('forgot_password.send_code')}
          </button>
        </form>
      ) : (
        <form
          onSubmit={submitReset}
          className="bg-s-paper border border-s-line rounded-lg p-5 flex flex-col gap-4"
        >
          <div>
            <span className="row gap-1.5 items-center text-[12.5px] font-semibold text-s-ink">
              <Lock size={14} className="text-s-muted" />
              {t('forgot_password.code_label')}
            </span>
            <div className="row gap-1.5 justify-center mt-2">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    boxRefs.current[i] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleBoxChange(i, e.target.value)}
                  onKeyDown={(e) => handleBoxKey(i, e)}
                  className="w-11 h-12 rounded-md border border-s-line text-center font-bold text-[18px] tracking-wide bg-s-paper focus:outline-none focus:border-brand"
                />
              ))}
            </div>
            <span className="text-[11.5px] text-s-muted mt-1.5 block text-center">
              {t('forgot_password.code_hint')}
            </span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="row gap-1.5 items-center text-[12.5px] font-semibold text-s-ink">
              <Lock size={14} className="text-s-muted" />
              {t('forgot_password.new_password_label')}
            </span>
            <input
              required
              type="password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input"
              autoComplete="new-password"
            />
            <span className="text-[11.5px] text-s-muted">
              {t('forgot_password.new_password_hint')}
            </span>
          </label>

          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || code.length !== OTP_LENGTH || newPassword.length < 8}
            className="btn btn-primary btn-block min-h-[46px] disabled:opacity-50"
          >
            {busy ? t('forgot_password.resetting') : t('forgot_password.reset_submit')}
          </button>

          <button
            type="button"
            onClick={() => setStep('identifier')}
            className="text-[12.5px] font-semibold text-s-muted hover:text-s-ink text-center"
          >
            {t('forgot_password.back_to_identifier')}
          </button>
        </form>
      )}
    </section>
  );
}
