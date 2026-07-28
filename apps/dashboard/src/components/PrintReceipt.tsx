import { useTranslation } from 'react-i18next';
import type { Restaurant } from '@plate-clean/shared-types';

/**
 * PrintReceipt — 80mm thermal-printer receipt shape, extracted from
 * BillViewModal so both the "view bill" modal and the OrderDetail
 * drawer can render + print through the same code path.
 *
 * Rendered as `display: none` on screen and flipped visible by the
 * `.rx-*` classes in index.css under `@media print`. The stylesheet
 * hides everything else on the page during print, so this element
 * must be present in the DOM at the moment `window.print()` fires.
 */

export interface Bill {
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

export interface BillLineItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: string | null;
  price_minor: number;
  line_total_minor: number;
}

function money(minor: number, currency: string): string {
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return `${sym}${(minor / 100).toFixed(2)}`;
}

function portionAbbrev(p: string | null): string {
  if (!p || p === 'regular') return '';
  if (p === 'small') return ' (S)';
  if (p === 'large') return ' (L)';
  return ` (${p})`;
}

interface Props {
  bill: Bill;
  restaurant: Restaurant | null;
  tableCode?: string;
  noGst: boolean;
  locale: string;
}

export function PrintReceipt({
  bill,
  restaurant,
  tableCode,
  noGst,
  locale,
}: Props) {
  const { t } = useTranslation();
  const issued = new Date(bill.issued_at);
  const dateStr = issued.toLocaleDateString(
    locale === 'en' ? 'en-IN' : locale,
    { year: 'numeric', month: 'short', day: '2-digit' },
  );
  const timeStr = issued.toLocaleTimeString(
    locale === 'en' ? 'en-IN' : locale,
    { hour: '2-digit', minute: '2-digit' },
  );

  return (
    <div className="rx-receipt" aria-hidden="true">
      <div className="rx-h1">{restaurant?.name ?? '—'}</div>
      {restaurant?.address && <div className="rx-sub">{restaurant.address}</div>}
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
        <div className="rx-note rx-center">
          {t('bill_view.receipt_no_gst_note')}
        </div>
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
