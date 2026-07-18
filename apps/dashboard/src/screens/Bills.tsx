import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Receipt,
  Download,
  ShoppingBag,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useToasts } from '../lib/toasts';
import { BillViewModal } from '../components/BillViewModal';

/**
 * Bills screen — every bill at the restaurant, filterable by month
 * and payment status, with a CA-facing xlsx export.
 *
 * List: 50 rows/page, cursor-paginated over `created_at DESC`. The
 * month picker and status filter reset pagination to page 1 whenever
 * they change. Row click opens the existing BillViewModal — the same
 * drawer staff already use from Live Orders + Past Orders, so we're
 * not shipping a new bill-detail surface just for this screen.
 *
 * Export: the Download Excel button opens its own 12-month menu, and
 * clicking a month triggers `GET /bills/export?month=YYYY-MM` and
 * lets the browser handle the download via a temporary anchor.
 */

type StatusFilter = 'all' | 'paid' | 'unpaid' | 'voided';
type Channel = 'qr' | 'walkin';

interface BillRow {
  id: string;
  meal_session_id: string;
  bill_number: string;
  created_at: string;
  channel: Channel;
  is_takeaway: boolean;
  table_code: string;
  customer_email: string | null;
  customer_phone: string | null;
  subtotal_minor: number;
  gst_rate: string;
  gst_amount_minor: number;
  total_minor: number;
  status: 'paid' | 'unpaid' | 'voided';
  voided_at: string | null;
  voided_reason: string | null;
}

interface ListResponse {
  rows: BillRow[];
  next_cursor: string | null;
}

interface MonthOption {
  key: string; // "YYYY-MM"
  label: string; // "July 2026"
}

function fmtRupees(minor: number): string {
  return (minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function last12Months(): MonthOption[] {
  // Rooted on the client's local `today` — the server also defaults
  // to the current-month bucket if `month` is omitted, so the two
  // clocks only diverge across a DST or midnight boundary and both
  // paths remain queryable via cursor if that mismatch bites.
  const out: MonthOption[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    out.push({ key, label });
  }
  return out;
}

export function Bills() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const pushToast = useToasts((s) => s.push);
  const monthOptions = useMemo(() => last12Months(), []);
  const [month, setMonth] = useState<string>(() => monthOptions[0]!.key);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [pages, setPages] = useState<BillRow[][]>([]);
  const [pageIdx, setPageIdx] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [modalFor, setModalFor] = useState<{ sessionId: string; tableCode: string } | null>(
    null,
  );

  const downloadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  // Reset the page stack whenever the filter changes — a status flip
  // shouldn't leave stale cursors in the accumulator.
  useEffect(() => {
    setPages([]);
    setPageIdx(0);
    setNextCursor(null);
  }, [month, statusFilter, restaurantId]);

  const filterKey = [restaurantId, month, statusFilter].join('|');

  const { data: firstPage, isLoading: firstLoading } = useQuery({
    queryKey: ['bills-list', filterKey],
    queryFn: async () => {
      const q = new URLSearchParams({
        month,
        status: statusFilter,
        limit: '50',
      });
      return api.get<ListResponse>(
        `/restaurants/${restaurantId}/bills?${q.toString()}`,
        token,
      );
    },
    enabled: Boolean(restaurantId && token),
  });

  useEffect(() => {
    if (firstPage) {
      setPages([firstPage.rows]);
      setPageIdx(0);
      setNextCursor(firstPage.next_cursor);
    }
  }, [firstPage]);

  async function loadNext() {
    if (loadingMore) return;
    // We already have the page cached — just advance the index.
    if (pageIdx + 1 < pages.length) {
      setPageIdx(pageIdx + 1);
      return;
    }
    if (!nextCursor || !restaurantId || !token) return;
    setLoadingMore(true);
    try {
      const q = new URLSearchParams({
        month,
        status: statusFilter,
        limit: '50',
        cursor: nextCursor,
      });
      const next = await api.get<ListResponse>(
        `/restaurants/${restaurantId}/bills?${q.toString()}`,
        token,
      );
      setPages((prev) => [...prev, next.rows]);
      setPageIdx((idx) => idx + 1);
      setNextCursor(next.next_cursor);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({ tone: 'alert', title: t('bills.load_error'), body: msg });
    } finally {
      setLoadingMore(false);
    }
  }

  function prevPage() {
    if (pageIdx > 0) setPageIdx(pageIdx - 1);
  }

  const currentRows = pages[pageIdx] ?? [];
  const hasNext = pageIdx + 1 < pages.length || nextCursor !== null;
  const hasPrev = pageIdx > 0;

  // Close the download dropdown on outside click. Uses the anchor ref
  // so clicks inside the menu (picking a month) don't trigger the
  // closer before the download handler runs.
  useEffect(() => {
    if (!downloadOpen) return;
    function handler(e: MouseEvent) {
      if (
        downloadRef.current &&
        !downloadRef.current.contains(e.target as Node)
      ) {
        setDownloadOpen(false);
      }
    }
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [downloadOpen]);

  async function download(exportMonth: string) {
    if (!restaurantId || !token) return;
    setDownloading(exportMonth);
    setDownloadOpen(false);
    try {
      // Bypass api.ts' JSON assumption — we need the raw response as
      // a Blob so the browser can save it as a file.
      const base = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1';
      const res = await fetch(
        `${base}/restaurants/${restaurantId}/bills/export?month=${exportMonth}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        // Try to surface the server's error message if there is one,
        // otherwise fall back to the status text.
        let msg = res.statusText;
        try {
          const j = await res.json();
          msg = j?.error?.message ?? j?.detail?.message ?? msg;
        } catch {
          /* ignore */
        }
        throw new ApiException(res.status, `HTTP_${res.status}`, msg);
      }
      // Grab the filename from Content-Disposition; fall back to a
      // sensible default if the header is missing (shouldn't happen).
      const disp = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disp);
      const filename = match?.[1] ?? `bills-${exportMonth}.xlsx`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({ tone: 'alert', title: t('bills.download_error'), body: msg });
    } finally {
      setDownloading(null);
    }
  }

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('bills.pick_restaurant')}</p>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide inline-flex items-center gap-1.5">
            <Receipt size={14} />
            {t('app.nav.bills')}
          </div>
          <h1 className="display text-[28px] text-s-ink leading-tight">
            {t('bills.title')}
          </h1>
          <p className="text-[12.5px] text-s-muted mt-1 max-w-[64ch]">
            {t('bills.blurb')}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <FilterField label={t('bills.filter_month')}>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-10 px-3 rounded-md border border-s-line bg-s-paper text-sm"
            >
              {monthOptions.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label={t('bills.filter_status')}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="h-10 px-3 rounded-md border border-s-line bg-s-paper text-sm"
            >
              <option value="all">{t('bills.filter_status_all')}</option>
              <option value="paid">{t('bills.filter_status_paid')}</option>
              <option value="unpaid">{t('bills.filter_status_unpaid')}</option>
              <option value="voided">{t('bills.filter_status_voided')}</option>
            </select>
          </FilterField>

          {/* Download Excel — button with its own 12-month dropdown. */}
          <div ref={downloadRef} className="relative">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-s-muted dev uppercase tracking-wide">
                {t('bills.export_label')}
              </span>
              <button
                type="button"
                onClick={() => setDownloadOpen((v) => !v)}
                disabled={downloading !== null}
                className={clsx(
                  'h-10 px-4 rounded-md bg-brand text-white font-semibold text-sm',
                  'inline-flex items-center gap-2 hover:bg-brand/90 transition disabled:opacity-60',
                )}
                aria-haspopup="menu"
                aria-expanded={downloadOpen}
              >
                {downloading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                {t('bills.download_excel')}
                <ChevronDown size={13} className="opacity-80" />
              </button>
            </label>
            {downloadOpen && (
              <div
                role="menu"
                className="absolute right-0 mt-1 z-20 min-w-[180px] rounded-md border border-s-line bg-s-paper shadow-lg py-1 max-h-[320px] overflow-y-auto"
              >
                {monthOptions.map((m) => (
                  <button
                    key={m.key}
                    role="menuitem"
                    type="button"
                    onClick={() => void download(m.key)}
                    className="w-full text-left px-3 py-2 text-sm text-s-ink hover:bg-s-bg transition"
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* table */}
      <div className="rounded-lg border border-s-line bg-s-paper overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[11px] text-s-muted dev uppercase tracking-wide bg-s-bg">
              <Th>{t('bills.col_date')}</Th>
              <Th>{t('bills.col_bill_number')}</Th>
              <Th>{t('bills.col_channel')}</Th>
              <Th>{t('bills.col_table')}</Th>
              <Th>{t('bills.col_customer')}</Th>
              <Th align="right">{t('bills.col_subtotal')}</Th>
              <Th align="right">{t('bills.col_gst')}</Th>
              <Th align="right">{t('bills.col_total')}</Th>
              <Th>{t('bills.col_status')}</Th>
            </tr>
          </thead>
          <tbody>
            {firstLoading && currentRows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-8 text-center text-s-muted">
                  {t('bills.loading')}
                </td>
              </tr>
            )}
            {!firstLoading && currentRows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-16 text-center">
                  <div className="flex flex-col items-center gap-2 text-s-muted">
                    <Receipt size={28} className="opacity-60" />
                    <div className="font-semibold text-s-ink">
                      {t('bills.empty_title')}
                    </div>
                    <div className="text-[12.5px]">
                      {t('bills.empty_hint')}
                    </div>
                  </div>
                </td>
              </tr>
            )}
            {currentRows.map((r) => (
              <tr
                key={r.id}
                onClick={() =>
                  setModalFor({
                    sessionId: r.meal_session_id,
                    tableCode: r.table_code,
                  })
                }
                className="border-t border-s-line hover:bg-s-bg/60 transition cursor-pointer"
              >
                <td className="px-3 py-2 whitespace-nowrap text-s-ink">
                  {fmtDate(r.created_at)}
                </td>
                <td className="px-3 py-2 font-mono text-s-ink whitespace-nowrap">
                  {r.bill_number}
                </td>
                <td className="px-3 py-2">
                  <ChannelChip channel={r.channel} isTakeaway={r.is_takeaway} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.is_takeaway ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-saffron-wash text-saffron-deep px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                      <ShoppingBag size={10} aria-hidden />
                      {t('bills.takeaway_pill')}
                    </span>
                  ) : (
                    <span className="font-mono text-s-ink">{r.table_code}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-s-ink whitespace-nowrap">
                  {r.customer_email || r.customer_phone || (
                    <span className="text-s-faint">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-right text-s-ink tabular-nums whitespace-nowrap">
                  ₹{fmtRupees(r.subtotal_minor)}
                </td>
                <td className="px-3 py-2 font-mono text-right text-s-muted tabular-nums whitespace-nowrap">
                  ₹{fmtRupees(r.gst_amount_minor)}
                </td>
                <td className="px-3 py-2 font-mono text-right text-s-ink font-semibold tabular-nums whitespace-nowrap">
                  ₹{fmtRupees(r.total_minor)}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* pagination */}
      {(hasPrev || hasNext) && (
        <div className="flex justify-between items-center">
          <div className="text-[12px] text-s-muted">
            {t('bills.page_indicator', {
              page: pageIdx + 1,
              count: currentRows.length,
            })}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={prevPage}
              disabled={!hasPrev}
              className="h-9 px-3 rounded-md border border-s-line bg-s-paper text-sm font-semibold text-s-ink hover:bg-s-bg transition disabled:opacity-40 inline-flex items-center gap-1"
            >
              <ChevronLeft size={14} />
              {t('bills.prev')}
            </button>
            <button
              type="button"
              onClick={() => void loadNext()}
              disabled={!hasNext || loadingMore}
              className="h-9 px-3 rounded-md border border-s-line bg-s-paper text-sm font-semibold text-s-ink hover:bg-s-bg transition disabled:opacity-40 inline-flex items-center gap-1"
            >
              {t('bills.next')}
              {loadingMore ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Detail view — the same BillViewModal Live + Past Orders open. */}
      {modalFor && (
        <BillViewModal
          sessionId={modalFor.sessionId}
          tableCode={modalFor.tableCode}
          onClose={() => setModalFor(null)}
        />
      )}
    </section>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-s-muted dev uppercase tracking-wide">
        {label}
      </span>
      {children}
    </label>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={clsx(
        'px-3 py-2 font-semibold',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function ChannelChip({
  channel,
  isTakeaway,
}: {
  channel: Channel;
  isTakeaway: boolean;
}) {
  const { t } = useTranslation();
  if (isTakeaway) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-saffron-wash text-saffron-deep px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
        {t('bills.channel_takeaway')}
      </span>
    );
  }
  if (channel === 'qr') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-wash text-brand px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
        {t('bills.channel_qr')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-s-bg text-s-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
      {t('bills.channel_walkin')}
    </span>
  );
}

function StatusPill({ status }: { status: BillRow['status'] }) {
  const { t } = useTranslation();
  const cls =
    status === 'paid'
      ? 'bg-sage-wash text-sage'
      : status === 'voided'
        ? 'bg-danger-wash text-danger'
        : 'bg-brand-wash text-brand';
  const label =
    status === 'paid'
      ? t('bills.status_paid')
      : status === 'voided'
        ? t('bills.status_voided')
        : t('bills.status_unpaid');
  return (
    <span
      className={clsx(
        'inline-flex items-center h-5 px-2 rounded-full text-[10px] font-bold uppercase tracking-wider',
        cls,
      )}
    >
      {label}
    </span>
  );
}
