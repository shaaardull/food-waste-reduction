import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, AlertCircle, Check, ChevronDown } from 'lucide-react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * RaiseDisputeModal — diner-facing "something went wrong" surface.
 *
 * Ethics rule 9 (diner recourse): if the staff rejects a score, the
 * diner can raise a dispute that the restaurant owner reviews within
 * 48 hours. This modal is the entry point.
 *
 * UX: a dropdown of common reasons keeps the review inbox structured
 * (owners can eyeball the top complaint pattern) and saves the diner
 * from a 20-char "what do I write?" problem. An "Other" option opens
 * a free-text textarea for cases that don't fit the buckets — same
 * 20-char minimum applies there so ops still gets actionable context.
 */

const MIN_OTHER_REASON = 20;
const OPTIONAL_DETAILS_MAX = 500;

// Kept as identifiers so a future analytics rollup can group by reason
// even after we translate the label. `other` is the free-text escape
// hatch; every other code carries a canonical English sentence in
// i18n so restaurant owners see the same wording across languages
// when triaging.
type ReasonCode =
  | 'plate_finished'
  | 'wrong_plate'
  | 'photo_issue'
  | 'staff_disagreement'
  | 'reward_not_honoured'
  | 'other';

const REASON_CODES: ReasonCode[] = [
  'plate_finished',
  'wrong_plate',
  'photo_issue',
  'staff_disagreement',
  'reward_not_honoured',
  'other',
];

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function RaiseDisputeModal({ sessionId, onClose }: Props) {
  const { t } = useTranslation();
  const { token } = useAuthStore();
  const qc = useQueryClient();

  const [reasonCode, setReasonCode] = useState<ReasonCode | ''>('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'sent'>('form');

  const isOther = reasonCode === 'other';

  const file = useMutation({
    mutationFn: (reasonText: string) =>
      api.post<{ dispute_id: string }>(
        `/sessions/${sessionId}/dispute`,
        { reason: reasonText },
        token,
      ),
    onSuccess: () => {
      setStep('sent');
      void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
    onError: (err: ApiException) => {
      setError(err.message ?? t('raise_dispute.error_generic'));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reasonCode) {
      setError(t('raise_dispute.err_reason_missing'));
      return;
    }
    const trimmed = details.trim();
    if (isOther && trimmed.length < MIN_OTHER_REASON) {
      setError(
        t('raise_dispute.err_reason_short', { min: MIN_OTHER_REASON }),
      );
      return;
    }
    // Compose the reason the backend stores. For pre-defined codes we
    // prepend the canonical English label so an owner reading the
    // support inbox sees a human sentence, then append optional
    // details. For "other" the diner's free text is the reason.
    let reasonText: string;
    if (isOther) {
      reasonText = trimmed;
    } else {
      const label = t(`raise_dispute.reason.${reasonCode}.label_en`, {
        defaultValue: t(`raise_dispute.reason.${reasonCode}.label`),
      });
      reasonText = trimmed ? `${label} — ${trimmed}` : label;
    }
    file.mutate(reasonText);
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-3">
      <div className="w-full max-w-[480px] bg-paper border border-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-danger dev uppercase tracking-wide row gap-1.5 items-center">
              <AlertCircle size={12} />
              {t('raise_dispute.eyebrow')}
            </div>
            <h2 className="display text-[24px] text-ink leading-tight">
              {step === 'sent'
                ? t('raise_dispute.sent_title')
                : t('raise_dispute.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label={t('raise_dispute.close')}
            className="w-8 h-8 rounded-md hover:bg-cream flex items-center justify-center text-muted"
          >
            <X size={16} />
          </button>
        </div>

        {step === 'sent' ? (
          <div className="px-5 py-8 flex flex-col items-center gap-3 text-center">
            <div className="w-16 h-16 rounded-full bg-sage-wash text-sage flex items-center justify-center">
              <Check size={30} />
            </div>
            <div>
              <div className="font-bold text-[16px] text-ink">
                {t('raise_dispute.sent_heading')}
              </div>
              <p className="text-[13px] text-muted mt-1 leading-snug max-w-[42ch]">
                {t('raise_dispute.sent_blurb')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="btn btn-outline mt-3 min-h-[44px] text-[14px] px-5"
            >
              {t('raise_dispute.done')}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
            <p className="text-[13.5px] text-muted leading-snug">
              {t('raise_dispute.blurb')}
            </p>

            <label className="block">
              <span className="text-[12.5px] font-semibold text-ink">
                {t('raise_dispute.field_reason')}
                <span className="text-danger ml-1">*</span>
              </span>
              <div className="relative mt-1">
                <select
                  autoFocus
                  required
                  value={reasonCode}
                  onChange={(e) =>
                    setReasonCode(e.target.value as ReasonCode | '')
                  }
                  className="input appearance-none pr-9 bg-paper w-full"
                >
                  <option value="" disabled>
                    {t('raise_dispute.reason_pick_placeholder')}
                  </option>
                  {REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {t(`raise_dispute.reason.${code}.label`)}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={16}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                />
              </div>
            </label>

            {reasonCode && (
              <label className="block">
                <span className="text-[12.5px] font-semibold text-ink">
                  {isOther
                    ? t('raise_dispute.field_other_details')
                    : t('raise_dispute.field_details_optional')}
                  {isOther && <span className="text-danger ml-1">*</span>}
                </span>
                <textarea
                  rows={isOther ? 5 : 3}
                  value={details}
                  onChange={(e) =>
                    setDetails(e.target.value.slice(0, OPTIONAL_DETAILS_MAX))
                  }
                  placeholder={
                    isOther
                      ? t('raise_dispute.reason_placeholder')
                      : t('raise_dispute.details_placeholder_optional')
                  }
                  className="input mt-1 resize-none"
                />
                <span className="text-[11.5px] text-muted mt-1 block">
                  {isOther
                    ? t('raise_dispute.reason_hint', { min: MIN_OTHER_REASON })
                    : t('raise_dispute.details_hint_optional')}
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
                {t('raise_dispute.cancel')}
              </button>
              <button
                type="submit"
                disabled={file.isPending || !reasonCode}
                className="btn flex-1 min-h-[46px] text-[14px] disabled:opacity-50 bg-danger text-white hover:bg-danger/90"
              >
                {file.isPending
                  ? t('raise_dispute.submitting')
                  : t('raise_dispute.submit')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
