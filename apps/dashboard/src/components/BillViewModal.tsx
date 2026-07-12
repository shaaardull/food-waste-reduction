import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Receipt, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import type { Restaurant } from '@plate-clean/shared-types';

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

interface BillLineItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: string | null;
  price_minor: number;
  line_total_minor: number;
}

interface Bill {
  id: string;
  meal_session_id: string;
  bill_number: string;
  line_items: BillLineItem[];
  subtotal_minor: number;
  discount_minor: number;
  reward_redemption_code: string | null;
  taxable_amount_minor: number;
  cgst_rate: string;
  sgst_rate: string;
  cgst_amount_minor: number;
  sgst_amount_minor: number;
  total_minor: number;
  currency: string;
  delivery_email: string | null;
  delivery_phone: string | null;
  delivered_via: string | null;
  delivery_status: 'pending' | 'sent' | 'failed';
  issued_at: string;
  sent_at: string | null;
}

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

/** Shorten "regular"/"small"/"large" to a single letter for the
 *  narrow 80mm column — the on-screen table has room to spell it,
 *  the receipt doesn't. */
function portionAbbrev(p: string | null): string {
  if (!p || p === 'regular') return '';
  if (p === 'small') return ' (S)';
  if (p === 'large') return ' (L)';
  return ` (${p})`;
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
          t={t}
        />
      )}
    </div>
  );
}

/**
 * PrintReceipt — the 80mm thermal-printer receipt shape.
 *
 * Kept in the same file as the modal because the two share ~5 fields
 * and splitting would just duplicate the money formatter. All styling
 * lives in the `.rx-*` classes in index.css so the receipt survives
 * the aggressive `display:none` sweep the print stylesheet does.
 */
function PrintReceipt({
  bill,
  restaurant,
  tableCode,
  noGst,
  locale,
  t,
}: {
  bill: Bill;
  restaurant: Restaurant | null;
  tableCode?: string;
  noGst: boolean;
  locale: string;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const issued = new Date(bill.issued_at);
  // Localised timestamp for the receipt header — matches the diner's
  // language toggle so a Marathi UI prints a Marathi date if the
  // locale carries one.
  const dateStr = issued.toLocaleDateString(locale === 'en' ? 'en-IN' : locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
  const timeStr = issued.toLocaleTimeString(locale === 'en' ? 'en-IN' : locale, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="rx-receipt" aria-hidden="true">
      {/* Header — restaurant identity. GSTIN prints only if the
          restaurant has one on file; the copy shifts to a small
          "Tax invoice not applicable" note when the restaurant has
          gst_enabled=false to keep the receipt legally clean. */}
      <div className="rx-h1">{restaurant?.name ?? '—'}</div>
      {restaurant?.address && (
        <div className="rx-sub">{restaurant.address}</div>
      )}
      {restaurant?.gstin && (
        <div className="rx-sub">
          {t('bill_view.receipt_gstin', { gstin: restaurant.gstin })}
        </div>
      )}
      <hr className="rx-hr" />

      <div className="rx-h2">
        {noGst
          ? t('bill_view.receipt_heading_no_gst')
          : t('bill_view.receipt_heading')}
      </div>
      <hr className="rx-hr" />

      {/* Bill metadata block — number, date, table, delivery target. */}
      <div className="rx-row">
        <span className="rx-l">{t('bill_view.receipt_bill_no')}</span>
        <span className="rx-r rx-mono rx-bold">{bill.bill_number}</span>
      </div>
      <div className="rx-row">
        <span className="rx-l">{t('bill_view.receipt_date')}</span>
        <span className="rx-r">
          {dateStr} · {timeStr}
        </span>
      </div>
      {tableCode && (
        <div className="rx-row">
          <span className="rx-l">{t('bill_view.receipt_table')}</span>
          <span className="rx-r rx-bold">{tableCode}</span>
        </div>
      )}
      {bill.delivery_email && (
        <div className="rx-row">
          <span className="rx-l">{t('bill_view.receipt_email')}</span>
          <span className="rx-r">{bill.delivery_email}</span>
        </div>
      )}
      <hr className="rx-hr" />

      {/* Items table — 3-col: name (elastic), qty, line total. Price
          per unit is dropped to make room; you can compute it from
          line_total / qty if a curious diner asks. */}
      <table>
        <thead>
          <tr>
            <th style={{ width: '58%' }}>{t('bill_view.col_item')}</th>
            <th style={{ width: '12%', textAlign: 'right' }}>
              {t('bill_view.col_qty')}
            </th>
            <th style={{ width: '30%', textAlign: 'right' }}>
              {t('bill_view.col_total')}
            </th>
          </tr>
        </thead>
        <tbody>
          {bill.line_items.map((li) => (
            <tr key={li.menu_item_id}>
              <td>
                {li.name}
                {portionAbbrev(li.portion_size)}
              </td>
              <td className="rx-num">{li.quantity}</td>
              <td className="rx-num">
                {money(li.line_total_minor, bill.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr className="rx-hr" />

      {/* Totals block. Mirrors the on-screen layout — subtotal, then
          reward discount (if applied), then GST split (or the no-GST
          note), then the bold total. */}
      <div className="rx-row">
        <span className="rx-l">{t('bill_view.subtotal')}</span>
        <span className="rx-r">{money(bill.subtotal_minor, bill.currency)}</span>
      </div>
      {bill.discount_minor > 0 && (
        <>
          <div className="rx-row">
            <span className="rx-l">
              {t('bill_view.reward_discount')}
              {bill.reward_redemption_code && (
                <> · <span className="rx-mono">{bill.reward_redemption_code}</span></>
              )}
            </span>
            <span className="rx-r">
              − {money(bill.discount_minor, bill.currency)}
            </span>
          </div>
          <div className="rx-row">
            <span className="rx-l">{t('bill_view.taxable')}</span>
            <span className="rx-r">
              {money(bill.taxable_amount_minor, bill.currency)}
            </span>
          </div>
        </>
      )}

      {noGst ? (
        <div className="rx-note rx-center">{t('bill_view.receipt_no_gst_note')}</div>
      ) : (
        <>
          <div className="rx-row">
            <span className="rx-l">
              {t('bill_view.cgst', {
                pct: (parseFloat(bill.cgst_rate) * 100).toFixed(2),
              })}
            </span>
            <span className="rx-r">
              {money(bill.cgst_amount_minor, bill.currency)}
            </span>
          </div>
          <div className="rx-row">
            <span className="rx-l">
              {t('bill_view.sgst', {
                pct: (parseFloat(bill.sgst_rate) * 100).toFixed(2),
              })}
            </span>
            <span className="rx-r">
              {money(bill.sgst_amount_minor, bill.currency)}
            </span>
          </div>
        </>
      )}

      <hr className="rx-hr-solid" />
      <div className="rx-row rx-total">
        <span className="rx-l">{t('bill_view.total')}</span>
        <span className="rx-r">{money(bill.total_minor, bill.currency)}</span>
      </div>
      <hr className="rx-hr-solid" />

      <div className="rx-footer">
        {t('bill_view.receipt_footer_thanks')}
        <br />
        {t('bill_view.receipt_footer_powered_by')}
      </div>
    </div>
  );
}
