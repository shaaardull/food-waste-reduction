import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  History,
  Timer,
  Receipt,
  Send,
  Eye,
  Check,
  XCircle,
  AlertCircle,
  Trophy,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { BillSendModal } from '../components/BillSendModal';
import { BillViewModal } from '../components/BillViewModal';

/**
 * Past orders — the historical counterpart to Live orders.
 *
 * Every session that has dropped off the live board (rewarded,
 * staff_approved / rejected, expired, disputed, cancelled) lands
 * here, newest first. From this screen the staff can:
 *   • view the bill (chip → BillViewModal)
 *   • resend the bill (button → BillSendModal, prefilled with the
 *     original delivery target if we still have it)
 *   • see the cancellation reason at a glance for cancelled orders
 *
 * Polls every 30 s — the past doesn't move often, but a bill going
 * from `pending` to `sent` after a Celery worker picks it up is a
 * legitimate live update we want.
 */

interface PastOrderItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: string | null;
  notes: string | null;
}

type PastStatus =
  | 'staff_approved'
  | 'staff_rejected'
  | 'rewarded'
  | 'expired'
  | 'disputed'
  | 'cancelled';

interface PastOrder {
  session_id: string;
  table_code: string;
  status: PastStatus;
  items: PastOrderItem[];
  started_at: string;
  started_seconds_ago: number;
  cancelled_reason: string | null;
  cancelled_at: string | null;
  bill_id: string | null;
  bill_number: string | null;
  bill_delivery_status: 'pending' | 'sent' | 'failed' | null;
  bill_total_minor: number | null;
  bill_sent_at: string | null;
  bill_delivery_email: string | null;
  bill_delivery_phone: string | null;
}

interface PastOrdersResponse {
  orders: PastOrder[];
}

function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  return `${d}d`;
}

function money(minor: number | null, currency = 'INR'): string {
  if (minor == null) return '—';
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return `${sym}${(minor / 100).toFixed(2)}`;
}

// Client-side pagination window. The endpoint hard-caps at 200 rows
// (see dashboard.py list_past_orders), so we fetch that upper bound and
// page through it in 15-row slices. Filter chips run on the same window
// so a "Rewarded"-only view stays consistent across page navigations.
// A busy restaurant will refetch the freshest 200 every 30 s regardless
// of which page the staff is currently viewing.
const PAGE_SIZE = 15;
const FETCH_LIMIT = 200;

export function PastOrders() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const [statusFilter, setStatusFilter] = useState<'all' | PastStatus>('all');
  const [page, setPage] = useState(1);
  const [billModalFor, setBillModalFor] = useState<PastOrder | null>(null);
  const [viewBillFor, setViewBillFor] = useState<PastOrder | null>(null);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  // Reset to page 1 whenever the filter changes — otherwise switching
  // from "All" (5 pages) to "Disputed" (1 page) leaves the staff on
  // page 4 of nothing.
  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['past-orders', restaurantId],
    queryFn: () =>
      api.get<PastOrdersResponse>(
        `/restaurants/${restaurantId}/dashboard/orders/past?limit=${FETCH_LIMIT}`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 30_000,
  });

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('summary.pick_restaurant')}</p>
    );
  }

  const orders = data?.orders ?? [];
  const filtered = useMemo(
    () =>
      statusFilter === 'all'
        ? orders
        : orders.filter((o) => o.status === statusFilter),
    [orders, statusFilter],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const paged = filtered.slice(start, start + PAGE_SIZE);
  const rangeEnd = Math.min(filtered.length, start + PAGE_SIZE);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
          <History size={12} />
          {t('app.nav.past_orders')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('past_orders.title')}
        </h1>
        <p className="text-[13px] text-s-muted mt-1 max-w-[62ch]">
          {t('past_orders.blurb')}
        </p>
      </header>

      {/* status filter chips */}
      <div className="row gap-1.5 flex-wrap">
        {(
          [
            'all',
            'rewarded',
            'staff_approved',
            'staff_rejected',
            'cancelled',
            'expired',
            'disputed',
          ] as const
        ).map((s) => {
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={clsx(
                'chip transition',
                active ? 'chip-brand' : 'chip-muted hover:bg-s-bg',
              )}
              aria-pressed={active}
            >
              {t(`past_orders.filter_${s}`)}
            </button>
          );
        })}
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {(error as Error).message}
        </p>
      )}

      {isLoading && (
        <p className="text-s-muted text-[13px]">{t('past_orders.loading')}</p>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="empty rounded-lg border border-s-line bg-s-paper">
          <div className="art">
            <History size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {t('past_orders.empty_title')}
          </p>
          <p className="text-[13px] text-s-muted mt-1.5 max-w-[42ch]">
            {t('past_orders.empty_blurb')}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {paged.map((o) => (
              <PastOrderRow
                key={o.session_id}
                order={o}
                onResend={setBillModalFor}
                onViewBill={setViewBillFor}
                t={t}
              />
            ))}
          </div>
          <Pagination
            page={safePage}
            pageCount={pageCount}
            rangeStart={start + 1}
            rangeEnd={rangeEnd}
            total={filtered.length}
            atCap={orders.length >= FETCH_LIMIT}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount, p + 1))}
            onGoto={setPage}
            t={t}
          />
        </>
      )}

      {billModalFor && (
        <BillSendModal
          sessionId={billModalFor.session_id}
          tableCode={billModalFor.table_code}
          prefillEmail={billModalFor.bill_delivery_email ?? undefined}
          prefillPhone={billModalFor.bill_delivery_phone ?? undefined}
          onClose={() => setBillModalFor(null)}
        />
      )}
      {viewBillFor && (
        <BillViewModal
          sessionId={viewBillFor.session_id}
          tableCode={viewBillFor.table_code}
          onClose={() => setViewBillFor(null)}
        />
      )}
    </section>
  );
}

/**
 * Pagination — compact prev / page-N-of-M / next controls. Rendered
 * only when there's more than one page; a range summary ("1–15 of 42")
 * hangs on the left so the staff always knows where they are.
 *
 * `atCap` fires when the fetch has hit the endpoint's hard limit of 200
 * rows. In that case we surface a "showing latest 200" note so staff
 * looking for very old orders don't wonder why the list stops.
 */
interface PaginationProps {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  atCap: boolean;
  onPrev: () => void;
  onNext: () => void;
  onGoto: (n: number) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function Pagination({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  atCap,
  onPrev,
  onNext,
  onGoto,
  t,
}: PaginationProps) {
  if (pageCount <= 1) {
    return (
      <div className="text-[12px] text-s-muted mt-2">
        {t('past_orders.pagination_range', {
          start: rangeStart,
          end: rangeEnd,
          total,
        })}
        {atCap && (
          <>
            {' · '}
            {t('past_orders.pagination_cap', { limit: FETCH_LIMIT })}
          </>
        )}
      </div>
    );
  }
  // Small windowed page number strip so we don't render 30 buttons for
  // a restaurant with 400 orders. Always show first, last, current, and
  // the two on either side of current; gaps get an ellipsis.
  const nums = new Set<number>([1, pageCount, page]);
  for (let i = 1; i <= 2; i++) {
    if (page - i >= 1) nums.add(page - i);
    if (page + i <= pageCount) nums.add(page + i);
  }
  const sorted = [...nums].sort((a, b) => a - b);

  return (
    <nav
      className="row spread items-center gap-3 flex-wrap mt-2 pt-3 border-t border-s-line/60"
      aria-label={t('past_orders.pagination_aria', {
        defaultValue: 'Past orders pagination',
      })}
    >
      <div className="text-[12px] text-s-muted">
        {t('past_orders.pagination_range', {
          start: rangeStart,
          end: rangeEnd,
          total,
        })}
        {atCap && (
          <>
            {' · '}
            {t('past_orders.pagination_cap', { limit: FETCH_LIMIT })}
          </>
        )}
      </div>
      <div className="row gap-1 items-center">
        <button
          type="button"
          onClick={onPrev}
          disabled={page <= 1}
          aria-label={t('past_orders.pagination_prev', {
            defaultValue: 'Previous page',
          })}
          className="w-8 h-8 rounded-md border border-s-line text-s-muted hover:text-s-ink hover:bg-s-bg disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center"
        >
          <ChevronLeft size={14} />
        </button>
        {sorted.map((n, idx) => {
          const prev = sorted[idx - 1];
          const gap = prev !== undefined && n - prev > 1;
          const active = n === page;
          return (
            <span key={n} className="row gap-1 items-center">
              {gap && (
                <span
                  aria-hidden
                  className="w-6 text-center text-[12px] text-s-muted"
                >
                  …
                </span>
              )}
              <button
                type="button"
                onClick={() => onGoto(n)}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'min-w-[32px] h-8 px-2 rounded-md text-[13px] font-semibold transition border',
                  active
                    ? 'bg-brand text-white border-brand'
                    : 'border-s-line text-s-ink hover:bg-s-bg',
                )}
              >
                {n}
              </button>
            </span>
          );
        })}
        <button
          type="button"
          onClick={onNext}
          disabled={page >= pageCount}
          aria-label={t('past_orders.pagination_next', {
            defaultValue: 'Next page',
          })}
          className="w-8 h-8 rounded-md border border-s-line text-s-muted hover:text-s-ink hover:bg-s-bg disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </nav>
  );
}

interface RowProps {
  order: PastOrder;
  onResend: (o: PastOrder) => void;
  onViewBill: (o: PastOrder) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function statusChipClass(status: PastStatus): string {
  switch (status) {
    case 'rewarded':
      return 'chip-saffron';
    case 'staff_approved':
      return 'chip-sage';
    case 'staff_rejected':
    case 'cancelled':
      return 'chip-danger';
    case 'expired':
      return 'chip-muted';
    case 'disputed':
      return 'chip-amber';
  }
}

function statusIcon(status: PastStatus) {
  switch (status) {
    case 'rewarded':
      return <Trophy size={11} />;
    case 'staff_approved':
      return <Check size={11} />;
    case 'staff_rejected':
    case 'cancelled':
      return <XCircle size={11} />;
    case 'expired':
      return <Timer size={11} />;
    case 'disputed':
      return <AlertCircle size={11} />;
  }
}

function PastOrderRow({ order, onResend, onViewBill, t }: RowProps) {
  const hasBill = order.bill_id !== null;
  const billStatus = order.bill_delivery_status;
  const billChipClass =
    billStatus === 'sent'
      ? 'chip-sage'
      : billStatus === 'pending'
        ? 'chip-amber'
        : billStatus === 'failed'
          ? 'chip-danger'
          : 'chip-muted';
  const billLabel = !hasBill
    ? t('orders.bill_none')
    : billStatus === 'sent'
      ? t('orders.bill_sent')
      : billStatus === 'pending'
        ? t('orders.bill_pending')
        : billStatus === 'failed'
          ? t('orders.bill_failed')
          : t('orders.bill_none');

  return (
    <article className="rounded-lg border border-s-line bg-s-paper p-3 flex flex-col gap-2">
      <div className="row spread items-start gap-3 flex-wrap">
        <div className="row gap-2 items-center flex-wrap">
          <span className="chip chip-brand">
            {t('queue.table', { code: order.table_code })}
          </span>
          <span className={clsx('chip', statusChipClass(order.status))}>
            {statusIcon(order.status)}
            {t(`past_orders.status_${order.status}`)}
          </span>
          <span className="row gap-1 items-center text-[11.5px] text-s-muted">
            <Timer size={11} />
            {t('past_orders.ago', { time: elapsed(order.started_seconds_ago) })}
          </span>
        </div>
        {order.bill_total_minor != null && (
          <span className="tnum font-bold text-[15px] text-s-ink">
            {money(order.bill_total_minor)}
          </span>
        )}
      </div>

      {order.items.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[13px] text-s-ink">
          {order.items.map((it) => (
            <li key={it.menu_item_id} className="row gap-2 items-baseline">
              <span className="tnum font-bold w-6 text-right">
                {it.quantity}×
              </span>
              <span className="flex-1 truncate">{it.name}</span>
              {it.portion_size && it.portion_size !== 'regular' && (
                <span className="chip chip-muted text-[10.5px]">
                  {it.portion_size}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {order.status === 'cancelled' && order.cancelled_reason && (
        <div className="text-[12px] text-s-muted italic bg-s-bg rounded-md px-2.5 py-1.5 border border-s-line/60">
          <span className="font-semibold not-italic">
            {t('past_orders.cancelled_reason_label')}:
          </span>{' '}
          {order.cancelled_reason}
        </div>
      )}

      <div className="row spread gap-2 pt-1 border-t border-s-line/60">
        {hasBill ? (
          <button
            type="button"
            onClick={() => onViewBill(order)}
            className={clsx('chip hover:opacity-80 transition', billChipClass)}
          >
            <Receipt size={11} />
            {order.bill_number ?? billLabel}
            <Eye size={10} className="opacity-70" />
          </button>
        ) : (
          <span className={clsx('chip', billChipClass)}>
            <Receipt size={11} />
            {billLabel}
          </span>
        )}
        {order.items.length > 0 && (
          <button
            type="button"
            onClick={() => onResend(order)}
            className="row gap-1.5 items-center text-[12.5px] font-semibold text-brand hover:underline"
          >
            <Send size={12} />
            {hasBill
              ? t('past_orders.resend_bill')
              : t('past_orders.send_bill')}
          </button>
        )}
      </div>
    </article>
  );
}
