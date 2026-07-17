import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Gift, ArrowUp, ArrowDown } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * Rewards analytics screen — three fixed-window stat cards up top,
 * a filter row, and a paginated table underneath.
 *
 * The summary card windows (today / 7d / 30d) are always fixed; the
 * table honors the from/to/status filter row. Pagination is cursor-
 * based over `issued_at` — the server returns `next_cursor` and the
 * "Load more" button appends the next 50 rows without resetting the
 * filter. Client-side sort is header-click; the server-side order is
 * always `issued_at DESC` so pagination stays consistent.
 */

type StatusFilter = 'all' | 'issued' | 'redeemed' | 'voided';

interface SummaryCard {
  count: number;
  value_minor: number;
  sparkline: number[];
}

interface SummaryResponse {
  today: SummaryCard;
  week: SummaryCard;
  month: SummaryCard;
}

interface RewardRow {
  id: string;
  redemption_code: string;
  table_code: string;
  value_minor: number;
  status: 'issued' | 'redeemed' | 'voided';
  issued_at: string;
  redeemed_at: string | null;
  voided_at: string | null;
}

interface ListResponse {
  rows: RewardRow[];
  next_cursor: string | null;
}

type SortKey = 'issued_at' | 'value_minor' | 'status' | 'table_code' | 'code';
type SortDir = 'asc' | 'desc';

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return isoDay(d);
}

function defaultToDate(): string {
  return isoDay(new Date());
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

function fmtRupees(minor: number): string {
  return (minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function Rewards() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const [from, setFrom] = useState<string>(defaultFromDate());
  const [to, setTo] = useState<string>(defaultToDate());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('issued_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [rows, setRows] = useState<RewardRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  // Cards' underlying query respects the filter per spec: the summary
  // endpoint always returns fixed windows independent of the filter,
  // but re-runs when the restaurant changes so switching restaurants
  // reloads. We do NOT re-key on the filter because the spec calls
  // out "cards always show their fixed windows, but the table
  // respects the filter."
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['rewards-summary', restaurantId],
    queryFn: () =>
      api.get<SummaryResponse>(
        `/restaurants/${restaurantId}/dashboard/rewards-summary`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 60_000,
  });

  // ISO datetime bounds — inclusive start of `from`, exclusive next
  // day of `to` so the picker's "to = today" includes anything issued
  // through end-of-day.
  const fromParam = useMemo(() => new Date(`${from}T00:00:00Z`).toISOString(), [from]);
  const toParam = useMemo(() => {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }, [to]);

  const filterKey = [restaurantId, fromParam, toParam, statusFilter].join('|');
  const { data: firstPage, isLoading: listLoading } = useQuery({
    queryKey: ['rewards-list', filterKey],
    queryFn: () => {
      const q = new URLSearchParams({
        from: fromParam,
        to: toParam,
        status: statusFilter,
        limit: '50',
      });
      return api.get<ListResponse>(
        `/restaurants/${restaurantId}/dashboard/rewards-list?${q.toString()}`,
        token,
      );
    },
    enabled: Boolean(restaurantId && token),
  });

  useEffect(() => {
    // Reset the accumulator whenever the filter changes so the "Load
    // more" cursor sequence starts fresh from page 1.
    if (firstPage) {
      setRows(firstPage.rows);
      setNextCursor(firstPage.next_cursor);
    }
  }, [firstPage]);

  async function loadMore() {
    if (!nextCursor || !restaurantId || !token || loadingMore) return;
    setLoadingMore(true);
    try {
      const q = new URLSearchParams({
        from: fromParam,
        to: toParam,
        status: statusFilter,
        limit: '50',
        cursor: nextCursor,
      });
      const next = await api.get<ListResponse>(
        `/restaurants/${restaurantId}/dashboard/rewards-list?${q.toString()}`,
        token,
      );
      setRows((prev) => [...prev, ...next.rows]);
      setNextCursor(next.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }

  function clickHeader(key: SortKey) {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('desc');
      return key;
    });
  }

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let av: string | number = 0;
      let bv: string | number = 0;
      switch (sortKey) {
        case 'issued_at':
          av = a.issued_at;
          bv = b.issued_at;
          break;
        case 'value_minor':
          av = a.value_minor;
          bv = b.value_minor;
          break;
        case 'status':
          av = a.status;
          bv = b.status;
          break;
        case 'table_code':
          av = a.table_code ?? '';
          bv = b.table_code ?? '';
          break;
        case 'code':
          av = a.redemption_code;
          bv = b.redemption_code;
          break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('rewards_screen.pick_restaurant')}</p>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide inline-flex items-center gap-1.5">
          <Gift size={14} />
          {t('app.nav.rewards')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('rewards_screen.title')}
        </h1>
        <p className="text-[12.5px] text-s-muted mt-1 max-w-[64ch]">
          {t('rewards_screen.blurb')}
        </p>
      </header>

      {/* stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard
          label={t('rewards_screen.card_today')}
          card={summary?.today}
          loading={summaryLoading}
        />
        <StatCard
          label={t('rewards_screen.card_week')}
          card={summary?.week}
          loading={summaryLoading}
        />
        <StatCard
          label={t('rewards_screen.card_month')}
          card={summary?.month}
          loading={summaryLoading}
        />
      </div>

      {/* filter row */}
      <div className="flex items-end gap-3 flex-wrap">
        <FilterField label={t('rewards_screen.filter_from')}>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-10 px-3 rounded-md border border-s-line bg-s-paper text-sm"
          />
        </FilterField>
        <FilterField label={t('rewards_screen.filter_to')}>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-10 px-3 rounded-md border border-s-line bg-s-paper text-sm"
          />
        </FilterField>
        <FilterField label={t('rewards_screen.filter_status')}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-10 px-3 rounded-md border border-s-line bg-s-paper text-sm"
          >
            <option value="all">{t('rewards_screen.filter_status_all')}</option>
            <option value="issued">
              {t('rewards_screen.filter_status_issued')}
            </option>
            <option value="redeemed">
              {t('rewards_screen.filter_status_redeemed')}
            </option>
            <option value="voided">
              {t('rewards_screen.filter_status_voided')}
            </option>
          </select>
        </FilterField>
      </div>

      {/* table */}
      <div className="rounded-lg border border-s-line bg-s-paper overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[11px] text-s-muted dev uppercase tracking-wide bg-s-bg">
              <SortableTh
                label={t('rewards_screen.table_col_date')}
                active={sortKey === 'issued_at'}
                dir={sortDir}
                onClick={() => clickHeader('issued_at')}
              />
              <SortableTh
                label={t('rewards_screen.table_col_table')}
                active={sortKey === 'table_code'}
                dir={sortDir}
                onClick={() => clickHeader('table_code')}
              />
              <SortableTh
                label={t('rewards_screen.table_col_code')}
                active={sortKey === 'code'}
                dir={sortDir}
                onClick={() => clickHeader('code')}
              />
              <SortableTh
                label={t('rewards_screen.table_col_value')}
                active={sortKey === 'value_minor'}
                dir={sortDir}
                onClick={() => clickHeader('value_minor')}
                align="right"
              />
              <SortableTh
                label={t('rewards_screen.table_col_status')}
                active={sortKey === 'status'}
                dir={sortDir}
                onClick={() => clickHeader('status')}
              />
            </tr>
          </thead>
          <tbody>
            {listLoading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-s-muted">
                  {t('rewards_screen.loading')}
                </td>
              </tr>
            )}
            {!listLoading && sortedRows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-s-muted">
                  {t('rewards_screen.table_empty')}
                </td>
              </tr>
            )}
            {sortedRows.map((r) => (
              <tr
                key={r.id}
                className="border-t border-s-line hover:bg-s-bg/60 transition"
              >
                <td className="px-3 py-2 whitespace-nowrap text-s-ink">
                  {fmtDate(r.issued_at)}
                </td>
                <td className="px-3 py-2 font-mono text-s-ink whitespace-nowrap">
                  {r.table_code}
                </td>
                <td className="px-3 py-2 font-mono font-bold text-s-ink whitespace-nowrap">
                  {r.redemption_code}
                </td>
                <td className="px-3 py-2 font-mono text-right text-s-ink tabular-nums whitespace-nowrap">
                  ₹{fmtRupees(r.value_minor)}
                </td>
                <td className="px-3 py-2">
                  <StatusChip status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="h-10 px-5 rounded-md border border-s-line bg-s-paper text-sm font-semibold text-s-ink hover:bg-s-bg transition disabled:opacity-60"
          >
            {loadingMore
              ? t('rewards_screen.loading_more')
              : t('rewards_screen.load_more')}
          </button>
        </div>
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

function StatCard({
  label,
  card,
  loading,
}: {
  label: string;
  card: SummaryCard | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const count = card?.count ?? 0;
  const value = card?.value_minor ?? 0;
  const sparkline = card?.sparkline ?? new Array(14).fill(0);
  return (
    <div className="bg-s-paper border border-s-line rounded-lg p-5 flex flex-col gap-3">
      <div className="text-[11px] font-semibold text-s-muted dev uppercase tracking-wide">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-bold text-s-ink tabular-nums">
          {loading ? '—' : count}
        </span>
        <span className="text-xs text-s-muted">
          {t('rewards_screen.card_count_suffix')}
        </span>
      </div>
      <div className="font-mono text-lg font-semibold text-brand tabular-nums">
        ₹{fmtRupees(value)}
      </div>
      <Sparkline data={sparkline} />
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const { t } = useTranslation();
  // 14 hand-rolled inline SVG bars — no chart dependency. Bars sized
  // relative to the max in the window so a quiet stretch still
  // renders a baseline. Baseline empty days use the muted line
  // colour; live days use the brand green.
  const max = Math.max(1, ...data);
  const width = 140;
  const height = 32;
  const gap = 2;
  const barWidth = (width - gap * (data.length - 1)) / data.length;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={t('rewards_screen.sparkline_alt')}
      className="shrink-0"
    >
      {data.map((v, i) => {
        const h = v === 0 ? 2 : Math.max(3, (v / max) * (height - 2));
        const x = i * (barWidth + gap);
        const y = height - h;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={1.5}
            fill={v === 0 ? 'hsl(214 22% 88%)' : 'hsl(153 43% 46%)'}
          />
        );
      })}
    </svg>
  );
}

function StatusChip({ status }: { status: RewardRow['status'] }) {
  const { t } = useTranslation();
  const cls =
    status === 'redeemed'
      ? 'bg-sage-wash text-sage'
      : status === 'voided'
        ? 'bg-danger-wash text-danger'
        : 'bg-brand-wash text-brand';
  const label =
    status === 'redeemed'
      ? t('rewards_screen.filter_status_redeemed')
      : status === 'voided'
        ? t('rewards_screen.filter_status_voided')
        : t('rewards_screen.filter_status_issued');
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

function SortableTh({
  label,
  active,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={clsx(
        'px-3 py-2 font-semibold',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={clsx(
          'inline-flex items-center gap-1 hover:text-s-ink transition',
          active ? 'text-s-ink' : 'text-s-muted',
        )}
      >
        {label}
        {active && (dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  );
}
