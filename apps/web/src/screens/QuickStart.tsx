import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { User } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

type Step = 'phone' | 'code';

/**
 * Anonymous diner mode (CLAUDE.md §9 Phase 3). The diner can complete
 * the whole meal flow without ever picking a password — just a phone
 * number + a one-time code. Their reward arrives both in-app and via
 * SMS, so closing the PWA mid-meal doesn't strand the code.
 *
 * Backend path: existing /auth/otp/request → /auth/otp/verify. The
 * verify endpoint auto-provisions a `phone+<digits>@plate-clean.local`
 * synthetic user, so we get the same in-app surface (rewards, profile)
 * as the email/password flow. SMS reward delivery kicks in at staff
 * approval — see app/services/sms.py.
 */
export function QuickStart() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [isAdult, setIsAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setStep('code');
    } catch (err) {
      setError(
        err instanceof ApiException ? err.message : t('quick_start.error_generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !requestId) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ user: User; token: string }>(
        '/auth/otp/verify',
        { request_id: requestId, code: code.trim() },
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

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">{t('quick_start.title')}</h1>
        <p className="text-sm text-slate-600">{t('quick_start.blurb')}</p>
      </header>

      {step === 'phone' ? (
        <form onSubmit={requestCode} className="space-y-3">
          <label className="block">
            <span className="text-sm text-slate-600">
              {t('quick_start.phone_label')}
            </span>
            <input
              required
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              autoComplete="tel"
              inputMode="tel"
            />
            <span className="text-xs text-slate-500 mt-1 block">
              {t('quick_start.phone_hint')}
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              required
              checked={isAdult}
              onChange={(e) => setIsAdult(e.target.checked)}
              className="mt-1"
            />
            <span>{t('quick_start.age_confirm')}</span>
          </label>

          {error && <p className="text-sm text-red-700">{error}</p>}

          <button
            type="submit"
            disabled={busy || !isAdult}
            className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white py-2 font-medium disabled:opacity-50"
          >
            {busy ? t('quick_start.sending') : t('quick_start.send_code')}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="space-y-3">
          <p className="text-sm text-slate-700">
            {t('quick_start.code_sent_to', { phone })}
          </p>
          <label className="block">
            <span className="text-sm text-slate-600">
              {t('quick_start.code_label')}
            </span>
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              maxLength={6}
              minLength={4}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-lg tracking-widest text-center"
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="••••••"
            />
            <span className="text-xs text-slate-500 mt-1 block">
              {t('quick_start.code_hint')}
            </span>
          </label>

          {error && <p className="text-sm text-red-700">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white py-2 font-medium disabled:opacity-50"
          >
            {busy ? t('quick_start.verifying') : t('quick_start.verify')}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setCode('');
              setError(null);
            }}
            className="block w-full text-sm text-brand-700 hover:underline"
          >
            {t('quick_start.back_to_phone')}
          </button>
        </form>
      )}

      <p className="text-xs text-slate-500 pt-3 border-t border-slate-100 text-center">
        <Link to="/login" className="text-brand-700 hover:underline">
          {t('quick_start.have_account')}
        </Link>
      </p>
    </section>
  );
}
