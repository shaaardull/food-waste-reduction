import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, AlertTriangle } from 'lucide-react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * CancelOrderModal — staff-side "cancel this order" sheet.
 *
 * Ethics rule 9 (diner recourse): a bare cancellation isn't allowed —
 * the staff member has to type a reason, which the diner sees on
 * SessionStatus. That's why the reason input is required with a
 * min-length of 4 chars (server-enforced too).
 *
 * The server refuses if a bill has already been issued (409
 * BILL_ALREADY_ISSUED). We surface that as a friendly error so the
 * staff member can void the bill first if the situation actually calls
 * for it (rare — usually if a bill exists, they need a refund, not a
 * cancel).
 */

interface Props {
  sessionId: string;
  tableCode: string;
  onClose: () => void;
  onCancelled?: () => void;
}

export function CancelOrderModal({ sessionId, tableCode, onClose, onCancelled }: Props) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const cancel = useMutation({
    mutationFn: () =>
      api.post(
        `/sessions/${sessionId}/cancel`,
        { reason: reason.trim() },
        token,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-orders', restaurantId] });
      onCancelled?.();
      onClose();
    },
    onError: (err: ApiException) => {
      const msg =
        (err.details as { message?: string } | undefined)?.message ??
        err.message ??
        t('cancel_order.err_generic');
      setError(msg);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (reason.trim().length < 4) {
      setError(t('cancel_order.err_reason_short'));
      return;
    }
    cancel.mutate();
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[480px] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-danger dev uppercase tracking-wide row gap-1.5 items-center">
              <AlertTriangle size={12} />
              {t('cancel_order.eyebrow')} · {tableCode}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {t('cancel_order.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
          <div className="row gap-3 items-start bg-danger-wash/60 border border-danger/20 rounded-md p-3">
            <AlertTriangle size={18} className="text-danger mt-0.5 flex-shrink-0" />
            <div className="text-[12.5px] text-s-ink leading-snug">
              {t('cancel_order.blurb')}
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('cancel_order.field_reason')}
              <span className="text-danger ml-1">*</span>
            </span>
            <textarea
              autoFocus
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('cancel_order.reason_placeholder')}
              className="input mt-0 resize-none"
            />
            <span className="text-[11.5px] text-s-muted">
              {t('cancel_order.reason_hint')}
            </span>
          </label>

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
              {t('cancel_order.keep')}
            </button>
            <button
              type="submit"
              disabled={cancel.isPending}
              className="btn flex-1 min-h-[44px] text-[14px] disabled:opacity-55 bg-danger text-white hover:bg-danger/90"
            >
              {cancel.isPending
                ? t('cancel_order.cancelling')
                : t('cancel_order.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
