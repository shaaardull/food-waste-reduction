import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Mail, Phone, Check, Receipt } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * BillSendModal — staff-side "generate + send this session's bill".
 *
 * Chains the same two API calls as the diner-side modal:
 *   POST /sessions/:id/bill          idempotent — returns existing bill
 *   POST /bills/:id/send             enqueues delivery
 *
 * Difference from the diner flow: staff supplies the recipient (they
 * ask the diner at the counter), no auto-fill from an auth store.
 */

interface Bill {
  id: string;
  bill_number: string;
  total_minor: number;
  currency: string;
}

interface Props {
  sessionId: string;
  tableCode?: string;
  onClose: () => void;
  onSent?: () => void;
}

export function BillSendModal({ sessionId, tableCode, onClose, onSent }: Props) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  const [channel, setChannel] = useState<'email' | 'sms' | 'both'>('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      const generated = await api.post<Bill>(
        `/sessions/${sessionId}/bill`,
        {},
        token,
      );
      const body: Record<string, string> = { via: channel };
      if (channel === 'email' || channel === 'both')
        body.target_email = email.trim();
      if (channel === 'sms' || channel === 'both')
        body.target_phone = phone.trim();
      await api.post(`/bills/${generated.id}/send`, body, token);
      return generated;
    },
    onSuccess: (created) => {
      setBill(created);
      setStep('sent');
      void qc.invalidateQueries({
        queryKey: ['live-orders', restaurantId],
      });
      onSent?.();
    },
    onError: (err: ApiException) => {
      const msg =
        (err.details as { message?: string } | undefined)?.message ??
        err.message ??
        t('bill_send.generic_error');
      setError(msg);
      setStep('form');
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if ((channel === 'email' || channel === 'both') && !email.trim()) {
      setError(t('bill_send.err_email_required'));
      return;
    }
    if ((channel === 'sms' || channel === 'both') && !phone.trim()) {
      setError(t('bill_send.err_phone_required'));
      return;
    }
    setStep('sending');
    send.mutate();
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[520px] max-h-[92vh] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('bill_send.eyebrow')}
              {tableCode && ` · ${tableCode}`}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {step === 'sent'
                ? t('bill_send.sent_title')
                : t('bill_send.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={16} />
          </button>
        </div>

        {step === 'sent' && bill && (
          <div className="px-5 py-8 flex flex-col items-center gap-3 text-center">
            <div className="w-16 h-16 rounded-full bg-sage-wash text-sage flex items-center justify-center">
              <Check size={30} />
            </div>
            <div>
              <div className="font-bold text-[15px] text-s-ink">
                {t('bill_send.sent_heading', {
                  number: bill.bill_number,
                })}
              </div>
              <p className="text-[13px] text-s-muted mt-1 leading-snug max-w-[40ch]">
                {t('bill_send.sent_blurb')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="btn btn-outline mt-2 min-h-[44px] text-[14px] px-5"
            >
              {t('bill_send.done')}
            </button>
          </div>
        )}

        {step !== 'sent' && (
          <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
            <div className="row gap-3 items-start bg-brand-wash/60 border border-brand/20 rounded-md p-3">
              <Receipt size={18} className="text-brand mt-0.5 flex-shrink-0" />
              <div className="text-[12.5px] text-s-ink leading-snug">
                {t('bill_send.blurb')}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold text-s-ink">
                {t('bill_send.field_channel')}
              </span>
              <div className="grid grid-cols-3 gap-2">
                {(['email', 'sms', 'both'] as const).map((c) => {
                  const active = channel === c;
                  const icon =
                    c === 'email' ? (
                      <Mail size={14} />
                    ) : c === 'sms' ? (
                      <Phone size={14} />
                    ) : null;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setChannel(c)}
                      className={clsx(
                        'row gap-1.5 items-center justify-center py-2 rounded-md border font-semibold text-[13px] transition',
                        active
                          ? 'bg-brand text-white border-brand'
                          : 'bg-s-paper border-s-line text-s-muted hover:text-s-ink',
                      )}
                      aria-pressed={active}
                    >
                      {icon}
                      {t(`bill_send.channel_${c}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            {(channel === 'email' || channel === 'both') && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold text-s-ink">
                  {t('bill_send.field_email')}
                </span>
                <input
                  required
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="diner@example.com"
                  className="input mt-0"
                />
              </label>
            )}

            {(channel === 'sms' || channel === 'both') && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold text-s-ink">
                  {t('bill_send.field_phone')}
                </span>
                <input
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="input mt-0"
                />
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
                className="btn btn-outline flex-1 min-h-[44px] text-[14px]"
              >
                {t('bill_send.cancel')}
              </button>
              <button
                type="submit"
                disabled={step === 'sending'}
                className="btn btn-primary flex-1 min-h-[44px] text-[14px] disabled:opacity-50"
              >
                {step === 'sending'
                  ? t('bill_send.sending')
                  : t('bill_send.send')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
