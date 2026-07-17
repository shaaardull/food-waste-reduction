import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  X,
  Timer,
  Plus,
  Printer,
  Mail,
  Banknote,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { StatePill } from './StatePill';
import { VoidOrderModal } from './VoidOrderModal';
import { BillSendModal } from './BillSendModal';
import { BillViewModal } from './BillViewModal';
import { EditItemsModal } from './EditItemsModal';
import type { Order } from '../screens/Orders';

/**
 * OrderDetailDrawer — right-side slide-over triggered by tapping any
 * Live Orders card (walk-in or QR).
 *
 * Walk-ins get the full action set: Print bill, Email bill, Mark paid,
 * Void. QR sessions get a read-only view (review status + view bill +
 * close) since their money path is handled by the validation flow;
 * "Mark paid" doesn't apply to a QR session that's still awaiting
 * capture.
 */

interface Props {
  order: Order;
  onClose: () => void;
}

function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const STATE_LABEL_KEY: Record<string, string> = {
  open: 'walkin.state_open',
  serving: 'walkin.state_serving',
  served: 'walkin.state_served',
  billed: 'walkin.state_billed',
  paid: 'walkin.state_paid',
  before_captured: 'walkin.state_before_photo',
  after_submitted: 'walkin.state_after_photo',
  pending_staff_validation: 'walkin.state_awaiting_review',
  rewarded: 'walkin.state_rewarded',
};

export function OrderDetailDrawer({ order, onClose }: Props) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  const [voidOpen, setVoidOpen] = useState(false);
  const [billSendOpen, setBillSendOpen] = useState(false);
  const [billViewOpen, setBillViewOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const isWalkin = order.entry_channel === 'walkin';
  const hasBill = order.bill_id !== null;
  const emailForDelivery = order.customer_email ?? undefined;
  const phoneForDelivery = order.customer_phone ?? undefined;
  const subtotalMinor = order.bill_total_minor ?? 0;
  const stateKey = STATE_LABEL_KEY[order.status];
  const stateLabel = stateKey ? t(stateKey) : order.status;
  const isPaid = (order.status as string) === 'paid';

  const markPaid = useMutation({
    mutationFn: () =>
      api.post(`/sessions/${order.session_id}/mark-paid`, undefined, token),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-orders', restaurantId] });
      onClose();
    },
  });

  return (
    <>
      <div className="fixed inset-0 z-40 flex justify-end">
        {/* Dimmed backdrop — click to close. */}
        <button
          type="button"
          aria-label={t('walkin.close_drawer')}
          onClick={onClose}
          className="absolute inset-0 bg-s-ink/40"
        />
        <div className="relative w-[420px] max-w-full h-full bg-s-paper shadow-pop flex flex-col animate-[slidein_.18s_ease-out]">
          {/* header */}
          <div className="px-6 pt-6 pb-4 border-b border-s-line">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-2xl font-bold text-s-ink truncate">
                  {order.table_code}
                </span>
                <span
                  className={clsx(
                    'inline-flex items-center h-5 px-2 rounded-full font-mono text-[10px] font-bold tracking-wider',
                    isWalkin
                      ? 'bg-s-line text-s-muted'
                      : 'bg-brand-wash text-brand',
                  )}
                >
                  {isWalkin ? 'WALK-IN' : 'QR'}
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('walkin.close_drawer')}
                className="w-8 h-8 rounded-lg hover:bg-s-bg flex items-center justify-center text-s-muted"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <StatePill state={order.status} label={stateLabel} />
              <span className="row gap-1 items-center text-xs text-s-faint">
                <Timer size={12} />
                {t('walkin.open_ago', { time: elapsed(order.started_seconds_ago) })}
              </span>
            </div>
          </div>

          {/* items */}
          <div className="flex-1 overflow-auto px-6 py-2">
            <div className="text-[11px] font-bold tracking-widest uppercase text-s-faint mt-3 mb-1">
              {t('walkin.items_heading')}
            </div>
            {order.items.length === 0 ? (
              <div className="py-6 text-center text-sm text-s-muted">
                {t('walkin.no_items')}
              </div>
            ) : (
              <ul className="divide-y divide-s-line">
                {order.items.map((it) => (
                  <li
                    key={it.menu_item_id}
                    className="py-3 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-s-ink truncate">
                        {it.name}
                      </div>
                      {it.notes && (
                        <div className="text-xs italic text-s-muted truncate">
                          {it.notes}
                        </div>
                      )}
                    </div>
                    <span className="font-mono text-sm font-bold text-s-ink tabular-nums shrink-0">
                      {it.quantity}×
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!hasBill && (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="mt-3 w-full h-11 rounded-lg border-2 border-dashed border-brand-line text-brand font-semibold text-sm inline-flex items-center justify-center gap-2 hover:bg-brand-wash transition"
              >
                <Plus size={16} />
                {t('walkin.add_items')}
              </button>
            )}
          </div>

          {/* subtotal + actions */}
          <div className="border-t border-s-line px-6 py-4">
            {subtotalMinor > 0 && (
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm text-s-muted">
                  {t('walkin.subtotal')}
                </span>
                <span className="font-mono text-xl font-bold text-s-ink">
                  ₹{(subtotalMinor / 100).toFixed(2)}
                </span>
              </div>
            )}

            {isWalkin ? (
              <>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="h-11 rounded-lg border border-s-line text-s-ink font-semibold text-sm inline-flex items-center justify-center gap-2 hover:bg-s-bg transition"
                  >
                    <Printer size={16} />
                    {t('walkin.print_bill')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBillSendOpen(true)}
                    className="h-11 rounded-lg border border-s-line text-s-ink font-semibold text-sm inline-flex items-center justify-center gap-2 hover:bg-s-bg transition"
                  >
                    <Mail size={16} />
                    {t('walkin.email_bill')}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => markPaid.mutate()}
                  disabled={markPaid.isPending || isPaid}
                  className="w-full h-12 rounded-lg bg-sage text-white font-semibold text-sm inline-flex items-center justify-center gap-2 hover:opacity-90 active:scale-[.98] mb-3 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Banknote size={18} />
                  {isPaid
                    ? t('walkin.paid_already')
                    : markPaid.isPending
                      ? t('walkin.marking_paid')
                      : t('walkin.mark_paid')}
                </button>
                <button
                  type="button"
                  onClick={() => setVoidOpen(true)}
                  className="w-full text-center text-sm font-semibold text-danger hover:underline"
                >
                  {t('walkin.void_order')}
                </button>
              </>
            ) : (
              <>
                {hasBill && (
                  <button
                    type="button"
                    onClick={() => setBillViewOpen(true)}
                    className="w-full h-11 rounded-lg border border-s-line text-s-ink font-semibold text-sm inline-flex items-center justify-center gap-2 hover:bg-s-bg transition mb-2"
                  >
                    {t('walkin.view_bill')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full h-11 rounded-lg border border-s-line text-s-muted font-semibold text-sm hover:bg-s-bg transition"
                >
                  {t('walkin.close')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {voidOpen && (
        <VoidOrderModal
          sessionId={order.session_id}
          tableCode={order.table_code}
          onClose={() => setVoidOpen(false)}
          onVoided={() => {
            setVoidOpen(false);
            onClose();
          }}
        />
      )}
      {billSendOpen && (
        <BillSendModal
          sessionId={order.session_id}
          tableCode={order.table_code}
          prefillEmail={emailForDelivery}
          prefillPhone={phoneForDelivery}
          onClose={() => setBillSendOpen(false)}
        />
      )}
      {billViewOpen && (
        <BillViewModal
          sessionId={order.session_id}
          tableCode={order.table_code}
          onClose={() => setBillViewOpen(false)}
        />
      )}
      {editOpen && restaurantId && (
        <EditItemsModal
          sessionId={order.session_id}
          tableCode={order.table_code}
          restaurantId={restaurantId}
          currentItems={order.items}
          onClose={() => setEditOpen(false)}
        />
      )}
    </>
  );
}
