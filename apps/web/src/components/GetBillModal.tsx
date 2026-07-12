import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Mail, Phone, Check, Sparkles, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
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
  discount_minor?: number;
  issued_at?: string;
}

interface RewardRow {
  id: string;
  redemption_code: string;
  reward_type: string;
  meal_session_id: string;
  value_minor: number;
  current_value_minor: number;
  restaurant_id: string;
  issued_at: string;
  half_value_at: string;
  expires_at: string;
  redeemed_at: string | null;
  voided_at: string | null;
}

interface SessionDetail {
  session: { id: string; restaurant_id: string; status: string };
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
  const [redemptionCode, setRedemptionCode] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  // Pull the session's restaurant_id so we can filter the diner's
  // reward list to codes issued at THIS restaurant. The server would
  // reject wrong-restaurant codes anyway, but we don't want to show
  // the diner a code that's guaranteed to error.
  const { data: sessionData } = useQuery<SessionDetail>({
    queryKey: ['session', sessionId],
    queryFn: () => api.get<SessionDetail>(`/sessions/${sessionId}`, token),
    enabled: Boolean(sessionId && token),
  });

  // Pull the diner's own rewards — server already scopes by user.
  // Newest issued first; we filter client-side to bill-discount codes
  // that are still usable AND belong to the same restaurant.
  const { data: rewardsData } = useQuery<RewardRow[]>({
    queryKey: ['my-rewards'],
    queryFn: () => api.get<RewardRow[]>('/rewards', token),
    enabled: Boolean(token),
  });

  const applicableRewards = useMemo(() => {
    if (!rewardsData) return [];
    const restaurantId = sessionData?.session?.restaurant_id;
    const now = Date.now();
    return rewardsData
      .filter((r) => r.reward_type === 'bill_discount')
      .filter((r) => r.redeemed_at === null && r.voided_at === null)
      .filter((r) => new Date(r.expires_at).getTime() > now)
      .filter((r) => !restaurantId || r.restaurant_id === restaurantId)
      .sort(
        (a, b) =>
          new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime(),
      );
  }, [rewardsData, sessionData]);

  // Peek at whether a bill already exists — same idempotency the
  // staff dashboard uses. Once it exists the diner is RESENDING a
  // frozen document, so we hide the coupon picker + text input and
  // skip the /sessions/:id/bill round-trip.
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
    enabled: Boolean(sessionId && token),
    staleTime: 0,
  });
  const existingBill = existingBillQuery.data ?? null;
  const isResend = Boolean(existingBill);

  const send = useMutation({
    mutationFn: async () => {
      // Resend path: the bill is immutable — same items, same
      // discount, same GST split, same issued_at. Round-tripping
      // /sessions/:id/bill again would silently discard any code the
      // diner just pasted (which is confusing), so we skip straight
      // to /bills/:id/send using the frozen bill's id.
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
      if (channel === 'email') body.target_email = email.trim();
      if (channel === 'sms') body.target_phone = phone.trim();
      await api.post(`/bills/${target.id}/send`, body, token);
      return target;
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

            {/* Resend banner — the bill is already frozen; we skip
                the coupon input entirely and confirm what's about to
                be re-mailed. */}
            {isResend && existingBill && (
              <div className="card p-3 bg-sage-wash/40 border-sage/25 flex flex-col gap-1">
                <div className="text-[12.5px] font-semibold text-ink">
                  {t('get_bill.resend_heading', {
                    number: existingBill.bill_number,
                  })}
                </div>
                <div className="text-[11.5px] text-muted leading-snug">
                  {t('get_bill.resend_frozen_note', {
                    total:
                      (existingBill.currency === 'INR' ? '₹' : '') +
                      (existingBill.total_minor / 100).toFixed(2),
                    date: existingBill.issued_at
                      ? new Date(existingBill.issued_at).toLocaleString()
                      : '',
                  })}
                </div>
                {existingBill.reward_redemption_code && (
                  <div className="text-[11.5px] text-sage font-semibold mt-0.5">
                    {t('get_bill.resend_coupon_applied', {
                      code: existingBill.reward_redemption_code,
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Coupon picker + input — hidden on resend since the
                bill is immutable. */}
            {!isResend && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold text-ink row gap-1.5 items-center">
                <Sparkles size={12} className="text-saffron-deep" />
                {t('get_bill.field_redemption_code')}
              </span>

              {/* Picker button — collapses / expands the reward list.
                  We show it only if there's at least one applicable
                  reward the diner could plausibly apply. */}
              {applicableRewards.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  className="row spread items-center bg-saffron-wash/60 border border-saffron-deep/25 rounded-md px-3 py-2 text-left hover:bg-saffron-wash transition"
                >
                  <span className="text-[12.5px] font-semibold text-ink">
                    {t('get_bill.pick_reward_button', {
                      count: applicableRewards.length,
                    })}
                  </span>
                  <ChevronDown
                    size={14}
                    className={clsx(
                      'transition-transform text-muted',
                      pickerOpen && 'rotate-180',
                    )}
                  />
                </button>
              )}

              {/* Scrollable reward list — newest first. Tapping a row
                  populates the input below. Max-height caps to ~3 rows
                  so a diner with a wall of rewards can still see the
                  send buttons underneath. */}
              {pickerOpen && applicableRewards.length > 0 && (
                <div className="max-h-[180px] overflow-y-auto rounded-md border border-line bg-paper flex flex-col divide-y divide-line/60">
                  {applicableRewards.map((r) => {
                    const active = redemptionCode === r.redemption_code;
                    // Same-session rewards are backend-blocked
                    // (REWARD_SAME_SESSION). Surface that up-front so
                    // the diner sees the row is unpickable rather than
                    // getting a red error after tapping. Keep it in
                    // the list — otherwise "where's my coupon?" is a
                    // worse UX than "why is my coupon dimmed?".
                    const sameSession = r.meal_session_id === sessionId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        disabled={sameSession}
                        onClick={() => {
                          if (sameSession) return;
                          setRedemptionCode(r.redemption_code);
                          setPickerOpen(false);
                        }}
                        className={clsx(
                          'row spread items-center px-3 py-2.5 transition text-left',
                          sameSession
                            ? 'bg-danger-wash/40 cursor-not-allowed'
                            : 'hover:bg-cream',
                          active && !sameSession && 'bg-saffron-wash/50',
                        )}
                        aria-disabled={sameSession}
                      >
                        <div className="flex flex-col min-w-0">
                          <span
                            className={clsx(
                              'font-mono tracking-wide text-[13px] font-bold truncate',
                              sameSession
                                ? 'text-danger/80 line-through'
                                : 'text-ink',
                            )}
                          >
                            {r.redemption_code}
                          </span>
                          <span
                            className={clsx(
                              'text-[11px] mt-0.5',
                              sameSession ? 'text-danger/70' : 'text-muted',
                            )}
                          >
                            {sameSession
                              ? t('get_bill.reward_row_same_session')
                              : t('get_bill.reward_row_value', {
                                  value: `₹${(r.current_value_minor / 100).toFixed(0)}`,
                                  date: new Date(r.expires_at).toLocaleDateString(),
                                })}
                          </span>
                        </div>
                        {active && !sameSession && (
                          <Check size={14} className="text-brand flex-shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              <input
                type="text"
                value={redemptionCode}
                onChange={(e) =>
                  setRedemptionCode(e.target.value.toUpperCase())
                }
                placeholder="PLATE-X7B2"
                className="input mt-0 font-mono tracking-wide"
                autoComplete="off"
              />
              <span className="text-[11.5px] text-muted">
                {applicableRewards.length > 0
                  ? t('get_bill.redemption_hint_with_picker')
                  : t('get_bill.redemption_hint')}
              </span>
            </div>
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
                {step === 'sending'
                  ? t('get_bill.sending')
                  : isResend
                    ? t('get_bill.resend')
                    : t('get_bill.send')}
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
