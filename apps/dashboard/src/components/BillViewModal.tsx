import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Receipt, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { PrintReceipt, type Bill } from './PrintReceipt';

/**
 * BillViewModal — staff-side full bill viewer.
 *
 * Opens from clicking the bill-status chip on an OrderCard once a bill
 * has been issued. Shows the same shape the diner receives in email —
 * itemized breakdown, GST split (or "no GST" note when the restaurant
 * has it disabled), reward-discount line if a redemption code was
 * applied, and the final total.
 *
 * Purely read-only — issuing/resending happens in BillSendModal.
 * The two modals are siblings, not stacked; clicking outside closes
 * whichever is open.
 */

interface Props {
  sessionId: string;
  /** Optional table code from the calling row (Orders / PastOrders).
   *  Threaded onto the receipt print output — useful for kitchens
   *  reconciling seat mapping after the fact. */
  tableCode?: string;
  onClose: () => void;
}

function money(minor: number, currency: string): string {
  // Paise → rupees with two decimals. Currency symbol on the left.
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return `${sym}${(minor / 100).toFixed(2)}`;
}

export function BillViewModal({ sessionId, tableCode, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const { token, activeRestaurant } = useAuthStore();

  const { data: bill, isLoading, error } = useQuery<Bill>({
    queryKey: ['session-bill', sessionId],
    queryFn: () => api.get<Bill>(`/sessions/${sessionId}/bill`, token),
    enabled: Boolean(sessionId && token),
  });

  const noGst =
    bill != null && bill.cgst_amount_minor === 0 && bill.sgst_amount_minor === 0;

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[600px] max-h-[92vh] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
              <Receipt size={12} />
              {t('bill_view.eyebrow')}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {bill ? bill.bill_number : t('bill_view.title')}
            </h2>
          </div>
          <div className="row gap-1 items-center">
            <button
              onClick={() => window.print()}
              className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
              aria-label={t('bill_view.print')}
              title={t('bill_view.print')}
            >
              <Printer size={16} />
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {isLoading && (
            <p className="text-s-muted text-[13px]">{t('bill_view.loading')}</p>
          )}

          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {(error as Error).message}
            </p>
          )}

          {bill && (
            <div className="flex flex-col gap-4">
              {/* Delivery status pill */}
              <div className="row gap-2 items-center text-[12px] text-s-muted">
                <span
                  className={`chip ${
                    bill.delivery_status === 'sent'
                      ? 'chip-sage'
                      : bill.delivery_status === 'failed'
                        ? 'chip-danger'
                        : 'chip-amber'
                  }`}
                >
                  {t(`bill_view.status_${bill.delivery_status}`)}
                </span>
                {bill.delivery_email && (
                  <span className="truncate">{bill.delivery_email}</span>
                )}
                {bill.delivery_phone && !bill.delivery_email && (
                  <span>{bill.delivery_phone}</span>
                )}
              </div>

              {/* Items table */}
              <div className="rounded-md border border-s-line overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead className="bg-s-bg text-s-muted text-[11.5px] uppercase tracking-wide dev">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">
                        {t('bill_view.col_item')}
                      </th>
                      <th className="text-right px-3 py-2 font-semibold w-14">
                        {t('bill_view.col_qty')}
                      </th>
                      <th className="text-right px-3 py-2 font-semibold w-24">
                        {t('bill_view.col_price')}
                      </th>
                      <th className="text-right px-3 py-2 font-semibold w-24">
                        {t('bill_view.col_total')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-s-line/60">
                    {bill.line_items.map((li) => (
                      <tr key={li.menu_item_id}>
                        <td className="px-3 py-2 text-s-ink">
                          <div className="font-semibold">{li.name}</div>
                          {li.portion_size && li.portion_size !== 'regular' && (
                            <div className="text-[11px] text-s-muted capitalize">
                              {li.portion_size}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tnum">
                          {li.quantity}
                        </td>
                        <td className="px-3 py-2 text-right tnum text-s-muted">
                          {money(li.price_minor, bill.currency)}
                        </td>
                        <td className="px-3 py-2 text-right tnum font-semibold">
                          {money(li.line_total_minor, bill.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals block */}
              <div className="flex flex-col gap-1.5 text-[13px]">
                <div className="row spread">
                  <span className="text-s-muted">
                    {t('bill_view.subtotal')}
                  </span>
                  <span className="tnum font-semibold">
                    {money(bill.subtotal_minor, bill.currency)}
                  </span>
                </div>

                {bill.discount_minor > 0 && (
                  <div className="row spread text-sage">
                    <span className="row gap-1.5 items-center">
                      {t('bill_view.reward_discount')}
                      {bill.reward_redemption_code && (
                        <span className="chip chip-sage text-[10.5px]">
                          {bill.reward_redemption_code}
                        </span>
                      )}
                    </span>
                    <span className="tnum font-semibold">
                      − {money(bill.discount_minor, bill.currency)}
                    </span>
                  </div>
                )}

                {bill.discount_minor > 0 && (
                  <div className="row spread">
                    <span className="text-s-muted">
                      {t('bill_view.taxable')}
                    </span>
                    <span className="tnum">
                      {money(bill.taxable_amount_minor, bill.currency)}
                    </span>
                  </div>
                )}

                {noGst ? (
                  <div className="row spread text-s-muted italic">
                    <span>{t('bill_view.no_gst')}</span>
                    <span>—</span>
                  </div>
                ) : (
                  <>
                    <div className="row spread">
                      <span className="text-s-muted">
                        {t('bill_view.cgst', {
                          pct: (parseFloat(bill.cgst_rate) * 100).toFixed(2),
                        })}
                      </span>
                      <span className="tnum">
                        {money(bill.cgst_amount_minor, bill.currency)}
                      </span>
                    </div>
                    <div className="row spread">
                      <span className="text-s-muted">
                        {t('bill_view.sgst', {
                          pct: (parseFloat(bill.sgst_rate) * 100).toFixed(2),
                        })}
                      </span>
                      <span className="tnum">
                        {money(bill.sgst_amount_minor, bill.currency)}
                      </span>
                    </div>
                  </>
                )}

                <div className="row spread pt-2 border-t border-s-line/60 text-[15px]">
                  <span className="font-bold">{t('bill_view.total')}</span>
                  <span className="tnum font-bold">
                    {money(bill.total_minor, bill.currency)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-s-line">
          <button
            onClick={onClose}
            className="btn btn-outline w-full min-h-[42px] text-[14px]"
          >
            {t('bill_view.close')}
          </button>
        </div>
      </div>

      {/* Print-only 80mm receipt. Renders in the DOM alongside the
          modal card but is `display:none` on screen; the print
          stylesheet flips it visible and hides everything else. */}
      {bill && (
        <PrintReceipt
          bill={bill}
          restaurant={activeRestaurant}
          tableCode={tableCode}
          noGst={noGst}
          locale={i18n.resolvedLanguage ?? 'en'}
        />
      )}
    </div>
  );
}

