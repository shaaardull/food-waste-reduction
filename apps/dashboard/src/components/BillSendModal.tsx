import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Mail, Phone, Check, Receipt } from 'lucide-react';
import { clsx } from 'clsx';
import { api, ApiException } from '../lib/api';
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
  reward_redemption_code?: string | null;
  discount_minor?: number;
  issued_at?: string;
}

interface Props {
  sessionId: string;
  tableCode?: string;
  /** Prefill the email input — used from the Past orders "Resend"
   *  button so staff don't retype the address the first delivery went
   *  to. */
  prefillEmail?: string;
  prefillPhone?: string;
  onClose: () => void;
  onSent?: () => void;
}

export function BillSendModal({
  sessionId,
  tableCode,
  prefillEmail,
  prefillPhone,
  onClose,
  onSent,
}: Props) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  const [channel, setChannel] = useState<'email' | 'sms' | 'both'>(
    prefillPhone && !prefillEmail ? 'sms' : 'email',
  );
  const [email, setEmail] = useState(prefillEmail ?? '');
  const [phone, setPhone] = useState(prefillPhone ?? '');
  const [redemptionCode, setRedemptionCode] = useState('');
  const [step, setStep] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);

  // Peek at whether a bill already exists for this session. If it does
  // we're in a RESEND — the discount, GST split, total, and issued_at
  // are all frozen server-side, so applying another coupon can't
  // change anything. We hide the coupon input and skip the generate
  // call, going straight to /bills/:id/send. If the peek 404s, this
  // is a fresh generation and we render the coupon input as before.
  const existingBillQuery = useQuery<Bill | null>({
    queryKey: ['session-bill-peek', sessionId],
    queryFn: async () => {
      try {
        return await api.get<Bill>(`/sessions/${sessionId}/bill`, token);
      } catch (err) {
        if (err instanceof ApiException && err.status === 404) return null;
        throw err;
      }
    },
    staleTime: 0,
  });
  const existingBill = existingBillQuery.data ?? null;
  const isResend = Boolean(existingBill);

  const send = useMutation({
    mutationFn: async () => {
      // If a bill already exists we DON'T re-hit /sessions/:id/bill —
      // that endpoint is idempotent server-side but round-tripping it
      // is wasted latency and (more importantly) reinforces the
      // misleading "coupon is being applied again" impression on the
      // frontend. Just re-mail the frozen bill.
      let target: Bill;
      if (existingBill) {
        target = existingBill;
      } else {
        const generateBody: Record<string, string> = {};
        if (redemptionCode.trim())
          generateBody.apply_redemption_code =
            redemptionCode.trim().toUpperCase();
        target = await api.post<Bill>(
          `/sessions/${sessionId}/bill`,
          generateBody,
          token,
        );
      }
      const body: Record<string, string> = { via: channel };
      if (channel === 'email' || channel === 'both')
        body.target_email = email.trim();
      if (channel === 'sms' || channel === 'both')
        body.target_phone = phone.trim();
      await api.post(`/bills/${target.id}/send`, body, token);
      return target;
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
            {/* Resend banner OR fresh-generation banner. The resend
                variant surfaces the frozen bill number + total + any
                previously-applied coupon so the staff sees exactly
                what's about to go out — no ambiguity about a new
                coupon being applied. */}
            {isResend && existingBill ? (
              <div className="row gap-3 items-start bg-sage-wash/60 border border-sage/25 rounded-md p-3">
                <Receipt size={18} className="text-sage mt-0.5 flex-shrink-0" />
                <div className="text-[12.5px] text-s-ink leading-snug flex-1">
                  <div className="font-semibold">
                    {t('bill_send.resend_heading', {
                      number: existingBill.bill_number,
                    })}
                  </div>
                  <div className="text-s-muted mt-0.5">
                    {t('bill_send.resend_frozen_note', {
                      total:
                        (existingBill.currency === 'INR' ? '₹' : '') +
                        (existingBill.total_minor / 100).toFixed(2),
                      date: existingBill.issued_at
                        ? new Date(existingBill.issued_at).toLocaleString()
                        : '',
                    })}
                  </div>
                  {existingBill.reward_redemption_code && (
                    <div className="mt-1 text-sage font-semibold text-[11.5px]">
                      {t('bill_send.resend_coupon_applied', {
                        code: existingBill.reward_redemption_code,
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="row gap-3 items-start bg-brand-wash/60 border border-brand/20 rounded-md p-3">
                <Receipt size={18} className="text-brand mt-0.5 flex-shrink-0" />
                <div className="text-[12.5px] text-s-ink leading-snug">
                  {t('bill_send.blurb')}
                </div>
              </div>
            )}

            {/* Coupon input only on FIRST send — the bill is
                immutable once generated, so a code entered on resend
                would silently do nothing. Hiding the field removes
                that confusion. */}
            {!isResend && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold text-s-ink">
                  {t('bill_send.field_redemption_code')}
                </span>
                <input
                  type="text"
                  value={redemptionCode}
                  onChange={(e) =>
                    setRedemptionCode(e.target.value.toUpperCase())
                  }
                  placeholder="PLATE-X7B2"
                  className="input mt-0 font-mono tracking-wide max-w-[240px]"
                  autoComplete="off"
                />
                <span className="text-[11.5px] text-s-muted">
                  {t('bill_send.redemption_hint')}
                </span>
              </label>
            )}

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
                  : isResend
                    ? t('bill_send.resend')
                    : t('bill_send.send')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
