import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * VoidOrderModal — staff-only "void this order" confirmation.
 *
 * Copy is verbatim from the walk-in spec. A required staff reason
 * (dropdown) is enforced in code, not just the disabled styling —
 * the API also rejects an empty reason (WalkinVoidIn min_length=4).
 *
 * On confirm the mutation hits POST /sessions/:id/void, refetches
 * the live-orders list, closes the modal, and lets the parent
 * dismiss the drawer.
 */

const REASON_KEYS = [
  'walkin.void_reason_guest_left',
  'walkin.void_reason_duplicate',
  'walkin.void_reason_switched_qr',
  'walkin.void_reason_entered_in_error',
] as const;

interface Props {
  sessionId: string;
  tableCode: string;
  onClose: () => void;
  onVoided?: () => void;
}

export function VoidOrderModal({ sessionId, tableCode, onClose, onVoided }: Props) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const voidMutation = useMutation({
    mutationFn: () =>
      api.post(`/sessions/${sessionId}/void`, { reason }, token),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-orders', restaurantId] });
      onVoided?.();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const disabled = !reason || voidMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={t('walkin.void_dismiss')}
        onClick={onClose}
        className="absolute inset-0 bg-s-ink/50"
      />
      <div className="relative w-[380px] max-w-full bg-s-paper rounded-xl p-6 shadow-pop">
        <div className="w-11 h-11 rounded-full bg-danger-wash text-danger flex items-center justify-center mb-4">
          <AlertTriangle size={22} />
        </div>
        <h3 className="font-bold text-lg text-s-ink mb-1.5">
          {t('walkin.void_title')}
        </h3>
        <p className="text-sm text-s-muted mb-4 leading-relaxed">
          {t('walkin.void_body', { table: tableCode })}
        </p>
        <label
          htmlFor="void-reason"
          className="block text-xs font-semibold text-s-muted mb-1.5"
        >
          {t('walkin.void_reason_label')}
        </label>
        <select
          id="void-reason"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          className="w-full h-11 px-3 rounded-lg border border-s-line text-sm mb-5 focus:outline-none focus:border-brand-line bg-s-paper"
        >
          <option value="">{t('walkin.void_reason_placeholder')}</option>
          {REASON_KEYS.map((key) => {
            const label = t(key);
            return (
              <option key={key} value={label}>
                {label}
              </option>
            );
          })}
        </select>
        {error && (
          <p className="text-xs text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 mb-4">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-lg border-2 border-s-line text-s-ink font-semibold text-sm hover:bg-s-bg transition"
          >
            {t('walkin.void_keep')}
          </button>
          <button
            type="button"
            onClick={() => voidMutation.mutate()}
            disabled={disabled}
            className="h-11 rounded-lg bg-danger text-white font-semibold text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {voidMutation.isPending ? t('walkin.void_working') : t('walkin.void_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
