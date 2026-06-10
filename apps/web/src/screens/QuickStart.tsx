import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import type { User } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LangToggle } from '../components/LangToggle';

type Step = 'phone' | 'code';

/**
 * Anonymous diner mode (CLAUDE.md §9 Phase 3): scan QR → phone OTP →
 * straight into the meal flow, no account creation. Reward arrives both
 * in-app and via SMS so closing the PWA mid-meal doesn't strand the
 * code. Backend path: /auth/otp/request → /auth/otp/verify.
 *
 * The OTP input is six segmented boxes (.otp-box from the design system)
 * with auto-advance, paste support, backspace-into-previous, and
 * arrow-key navigation — same affordances every iOS/Android OS-level
 * OTP autofill flow gives.
 */
const OTP_LENGTH = 6;

export function QuickStart() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [requestId, setRequestId] = useState<string | null>(null);
  const [isAdult, setIsAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRefs = useRef<Array<HTMLInputElement | null>>([]);

  // Focus first box when entering the code step.
  useEffect(() => {
    if (step === 'code') {
      // Microtask so the input is mounted before we ask it to focus.
      queueMicrotask(() => boxRefs.current[0]?.focus());
    }
  }, [step]);

  const code = digits.join('');

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ request_id: string }>('/auth/otp/request', {
        phone: phone.trim(),
      });
      setRequestId(res.request_id);
      setDigits(Array(OTP_LENGTH).fill(''));
      setStep('code');
    } catch (err) {
      setError(
        err instanceof ApiException ? err.message : t('quick_start.error_generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(submitted: string) {
    if (!requestId || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ user: User; token: string }>(
        '/auth/otp/verify',
        { request_id: requestId, code: submitted },
      );
      setAuth(res.user, res.token);
      navigate('/scan');
    } catch (err) {
      setError(
        err instanceof ApiException ? err.message : t('quick_start.error_generic'),
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
      if (onlyDigits.length >= OTP_LENGTH) void verify(next.join(''));
      return;
    }
    const next = [...digits];
    next[i] = onlyDigits.slice(-1);
    setDigits(next);
    if (next[i] && i < OTP_LENGTH - 1) boxRefs.current[i + 1]?.focus();
    if (next.every((d) => d) && next.join('').length === OTP_LENGTH) {
      void verify(next.join(''));
    }
  }

  function handleBoxKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      e.preventDefault();
      const next = [...digits];
      next[i - 1] = '';
      setDigits(next);
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
          to="/"
          className="btn-tertiary !min-h-0 !p-1 inline-flex items-center gap-1.5"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </Link>
        <LangToggle />
      </div>

      <div className="max-w-md mx-auto px-5 pt-6 pb-10 space-y-6">
        {/* progress strip */}
        <div className="steps">
          <div className={`s ${step === 'phone' ? 'on' : 'on'}`} />
          <div className={`s ${step === 'code' ? 'on' : ''}`} />
        </div>

        <header className="space-y-1.5">
          <div className="eyebrow text-brand">{t('quick_start.title')}</div>
          <h1 className="display text-[34px] text-ink leading-tight">
            {t('quick_start.title')}
          </h1>
          <p className="text-[15px] text-muted leading-relaxed pt-1">
            {step === 'phone'
              ? t('quick_start.blurb')
              : t('quick_start.code_sent_to', { phone })}
          </p>
        </header>

        {step === 'phone' ? (
          <form onSubmit={requestCode} className="space-y-4">
            <label className="block">
              <span className="text-xs text-muted font-medium">
                {t('quick_start.phone_label')}
              </span>
              <input
                required
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className="input !text-base !py-3"
                autoComplete="tel"
                inputMode="tel"
              />
              <span className="text-xs text-faint mt-1.5 block">
                {t('quick_start.phone_hint')}
              </span>
            </label>

            <label className="flex items-start gap-2 text-sm text-muted">
              <input
                type="checkbox"
                required
                checked={isAdult}
                onChange={(e) => setIsAdult(e.target.checked)}
                className="mt-1"
              />
              <span>{t('quick_start.age_confirm')}</span>
            </label>

            {error && (
              <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !isAdult}
              className="btn btn-primary btn-lg btn-block disabled:opacity-50"
            >
              {busy ? t('quick_start.sending') : t('quick_start.send_code')}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="otp">
              {digits.map((d, i) => {
                const active = code.length === i;
                const filled = Boolean(d);
                return (
                  <input
                    key={i}
                    ref={(el) => {
                      boxRefs.current[i] = el;
                    }}
                    value={d}
                    onChange={(e) => handleBoxChange(i, e.target.value)}
                    onKeyDown={(e) => handleBoxKey(i, e)}
                    onFocus={(e) => e.currentTarget.select()}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6 /* allow paste */}
                    aria-label={`Digit ${i + 1}`}
                    className={`otp-box outline-none ${
                      filled ? 'filled' : ''
                    } ${active && !filled ? 'active' : ''}`}
                  />
                );
              })}
            </div>
            <p className="text-xs text-faint text-center">
              {t('quick_start.code_hint')}
            </p>

            {error && (
              <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 text-center">
                {error}
              </p>
            )}

            <button
              onClick={() => void verify(code)}
              disabled={busy || code.length < OTP_LENGTH}
              className="btn btn-primary btn-lg btn-block disabled:opacity-50"
            >
              {busy ? t('quick_start.verifying') : t('quick_start.verify')}
            </button>

            <button
              type="button"
              onClick={() => {
                setStep('phone');
                setDigits(Array(OTP_LENGTH).fill(''));
                setError(null);
              }}
              className="btn-tertiary block w-full text-sm"
            >
              <span className="text-brand">
                {t('quick_start.back_to_phone')}
              </span>
            </button>
          </div>
        )}

        <p className="text-xs text-faint text-center pt-3 border-t border-line">
          <Link to="/login" className="text-brand hover:underline">
            {t('quick_start.have_account')}
          </Link>
        </p>
      </div>
    </div>
  );
}
