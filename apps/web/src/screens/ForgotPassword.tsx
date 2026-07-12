import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check } from 'lucide-react';
import type { User } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LangToggle } from '../components/LangToggle';

/**
 * ForgotPassword — two-step SMS-based password reset.
 *
 *   Step 1 (identifier): user types their email OR phone. We call
 *   POST /auth/forgot-password → we get a request_id back and the
 *   server texts an OTP to the phone on file. To harden against
 *   account enumeration the server ALSO returns a synthesised
 *   request_id when the identifier is unknown, so we can't
 *   distinguish success from failure client-side — we just move to
 *   step 2 either way.
 *
 *   Step 2 (code + new password): 6-digit OTP boxes matched to the
 *   QuickStart affordances (auto-advance, paste-across, backspace-
 *   into-previous) plus a new-password field. On success we get a
 *   fresh auth token and drop the diner straight into /scan — no
 *   sign-in round-trip after the reset.
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
  const boxRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (step === 'reset') {
      queueMicrotask(() => boxRefs.current[0]?.focus());
    }
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
      // /forgot-password should never surface an error to the client
      // (see enumeration-hardening) but network / 5xx are still real.
      setError(
        err instanceof ApiException ? err.message : t('forgot_password.error_generic'),
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
      const res = await api.post<{ user: User; token: string }>(
        '/auth/reset-password',
        {
          request_id: requestId,
          code,
          new_password: newPassword,
        },
      );
      setAuth(res.user, res.token);
      navigate('/scan');
    } catch (err) {
      setError(
        err instanceof ApiException ? err.message : t('forgot_password.error_generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  function handleBoxChange(i: number, val: string) {
    const onlyDigits = val.replace(/\D/g, '');
    // Paste case: user pastes "482915" into one box → spread across all.
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
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      boxRefs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < OTP_LENGTH - 1) {
      e.preventDefault();
      boxRefs.current[i + 1]?.focus();
    }
  }

  return (
    <div className="d-screen min-h-full">
      <div className="px-5 pt-4 spread">
        <Link
          to="/login"
          className="btn-tertiary !min-h-0 !p-1 inline-flex items-center gap-1.5"
          aria-label={t('forgot_password.back')}
        >
          <ArrowLeft size={20} />
        </Link>
        <LangToggle />
      </div>

      <div className="max-w-md mx-auto px-5 pt-6 pb-10 space-y-5">
        {/* progress strip — mirrors QuickStart so the two-step feel is
            consistent across the OTP flows. */}
        <div className="steps">
          <div className={`s ${step === 'identifier' ? 'on' : 'on'}`} />
          <div className={`s ${step === 'reset' ? 'on' : ''}`} />
        </div>

        <header className="space-y-1.5">
          <div className="eyebrow text-brand">
            {t('forgot_password.eyebrow')}
          </div>
          <h1 className="display text-[34px] text-ink leading-tight">
            {step === 'identifier'
              ? t('forgot_password.title')
              : t('forgot_password.reset_title')}
          </h1>
          <p className="text-[14.5px] text-muted leading-relaxed pt-1">
            {step === 'identifier'
              ? t('forgot_password.blurb')
              : t('forgot_password.reset_blurb')}
          </p>
        </header>

        {step === 'identifier' ? (
          <form onSubmit={requestReset} className="space-y-4">
            <label className="block">
              <span className="text-xs text-muted font-medium">
                {t('forgot_password.identifier_label')}
              </span>
              <input
                required
                autoFocus
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@example.com  ·  +91 98765 43210"
                className="input !text-base !py-3"
                autoComplete="email"
              />
              <span className="text-[11.5px] text-faint mt-1 block">
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
              className="btn btn-primary btn-lg btn-block disabled:opacity-50"
            >
              {busy ? t('forgot_password.sending') : t('forgot_password.send_code')}
            </button>
          </form>
        ) : (
          <form onSubmit={submitReset} className="space-y-4">
            <div>
              <span className="text-xs text-muted font-medium">
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
                    className="otp-box"
                  />
                ))}
              </div>
              <span className="text-[11.5px] text-faint mt-1.5 block text-center">
                {t('forgot_password.code_hint')}
              </span>
            </div>

            <label className="block">
              <span className="text-xs text-muted font-medium">
                {t('forgot_password.new_password_label')}
              </span>
              <input
                required
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input !text-base !py-3"
                autoComplete="new-password"
              />
              <span className="text-[11.5px] text-faint mt-1 block">
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
              className="btn btn-primary btn-lg btn-block disabled:opacity-50"
            >
              {busy ? (
                t('forgot_password.resetting')
              ) : (
                <>
                  <Check size={18} /> {t('forgot_password.reset_submit')}
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setStep('identifier')}
              className="btn-tertiary block w-full text-[13px]"
            >
              {t('forgot_password.back_to_identifier')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
