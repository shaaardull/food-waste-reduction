import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Mail, Phone, Check, Sparkles } from 'lucide-react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * GetBillModal — diner-side "Send me the bill" sheet.
 *
 * Two API calls chained:
 *   POST /sessions/:id/bill      → idempotent, snapshots + returns bill
 *   POST /bills/:id/send         → enqueues delivery
 *
 * The frontend doesn't wait for delivery to complete (the Celery task
 * can take 5–20 s). We show a success banner as soon as the /send
 * endpoint returns 202 — same UX shape as pressing "Send" in Gmail.
 */

interface Bill {
  id: string;
  bill_number: string;
  total_minor: number;
  currency: string;
  reward_redemption_code: string | null;
}

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function GetBillModal({ sessionId, onClose }: Props) {
  const { t } = useTranslation();
  const { user, token } = useAuthStore();
  const qc = useQueryClient();

  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  // Prefill with whatever the auth-store knows about the user; some
  // diners have both.
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      // Step 1: generate (or fetch existing) bill for this session.
      const generated = await api.post<Bill>(
        `/sessions/${sessionId}/bill`,
        {},
        token,
      );
      // Step 2: dispatch delivery.
      const body: Record<string, string> = { via: channel };
      if (channel === 'email') body.target_email = email.trim();
      if (channel === 'sms') body.target_phone = phone.trim();
      await api.post(`/bills/${generated.id}/send`, body, token);
      return generated;
    },
    onSuccess: (created) => {
      setBill(created);
      setStep('sent');
      // Nudge SessionStatus to re-fetch — the reward-panel query
      // shares invalidation with 'session' key, cheap.
      void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
    onError: (err: ApiException) => {
      const msg =
        (err.details as { message?: string } | undefined)?.message ??
        err.message ??
        t('get_bill.generic_error');
      setError(msg);
      setStep('form');
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (channel === 'email' && !email.trim()) {
      setError(t('get_bill.err_email_required'));
      return;
    }
    if (channel === 'sms' && !phone.trim()) {
      setError(t('get_bill.err_phone_required'));
      return;
    }
    setStep('sending');
    send.mutate();
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-3">
      <div className="w-full max-w-[480px] bg-paper border border-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-muted dev uppercase tracking-wide">
              {t('get_bill.eyebrow')}
            </div>
            <h2 className="display text-[24px] text-ink leading-tight">
              {step === 'sent'
                ? t('get_bill.sent_title')
                : t('get_bill.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label={t('get_bill.close')}
            className="w-8 h-8 rounded-md hover:bg-cream flex items-center justify-center text-muted"
          >
            <X size={16} />
          </button>
        </div>

        {step === 'sent' && bill && (
          <div className="px-5 py-6 flex flex-col items-center gap-3 text-center">
            <div className="w-16 h-16 rounded-full bg-sage-wash text-sage flex items-center justify-center">
              <Check size={30} />
            </div>
            <div>
              <div className="font-bold text-[16px] text-ink">
                {t('get_bill.sent_heading')}
              </div>
              <p className="text-[13px] text-muted mt-1 leading-snug">
                {channel === 'email'
                  ? t('get_bill.sent_email_blurb', { target: email })
                  : t('get_bill.sent_sms_blurb', { target: phone })}
              </p>
            </div>
            {bill.reward_redemption_code && (
              <div className="mt-1 chip chip-saffron">
                <Sparkles size={12} />
                {t('get_bill.reward_applied_chip')}
              </div>
            )}
            <button
              onClick={onClose}
              className="btn btn-outline mt-3 min-h-[44px] text-[14px] px-5"
            >
              {t('get_bill.done')}
            </button>
          </div>
        )}

        {step !== 'sent' && (
          <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
            <p className="text-[13.5px] text-muted leading-snug">
              {t('get_bill.blurb')}
            </p>

            {/* channel toggle */}
            <div className="flex gap-2">
              <ChannelButton
                icon={<Mail size={16} />}
                label={t('get_bill.channel_email')}
                active={channel === 'email'}
                onClick={() => setChannel('email')}
              />
              <ChannelButton
                icon={<Phone size={16} />}
                label={t('get_bill.channel_sms')}
                active={channel === 'sms'}
                onClick={() => setChannel('sms')}
              />
            </div>

            {channel === 'email' && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold text-ink">
                  {t('get_bill.field_email')}
                </span>
                <input
                  required
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="input mt-0"
                />
              </label>
            )}

            {channel === 'sms' && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold text-ink">
                  {t('get_bill.field_phone')}
                </span>
                <input
                  required
                  type="tel"
                  autoFocus
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="input mt-0"
                />
                <span className="text-[11.5px] text-muted">
                  {t('get_bill.sms_hint')}
                </span>
              </label>
            )}

            {error && (
              <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <div className="row gap-2">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-outline flex-1 min-h-[46px] text-[14px]"
              >
                {t('get_bill.cancel')}
              </button>
              <button
                type="submit"
                disabled={step === 'sending'}
                className="btn btn-primary flex-1 min-h-[46px] text-[14px] disabled:opacity-50"
              >
                {step === 'sending' ? t('get_bill.sending') : t('get_bill.send')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ChannelButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 row gap-2 items-center justify-center py-2.5 rounded-md border font-semibold text-[13.5px] transition ${
        active
          ? 'bg-brand text-white border-brand'
          : 'bg-paper border-line text-muted hover:text-ink'
      }`}
      aria-pressed={active}
    >
      {icon}
      {label}
    </button>
  );
}
