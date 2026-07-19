import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BarChart3, ArrowUp, ArrowDown, TrendingUp, Users, Utensils, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * Analytics overview — sales + traffic signal on a single screen,
 * scoped to the currently-selected restaurant. Sourced from ONE
 * aggregated backend call so switching the range picker triggers a
 * single round-trip.
 *
 * Layout:
 *   Row 1 — Revenue trend chart (2/3) + Revenue stat card (1/3)
 *   Row 2 — Peak-hours heatmap (full width)
 *   Row 3 — Top items (2/3) + New-vs-repeat diner ratio (1/3)
 *   Row 4 — Avg-ticket stat card
 *
 * Every chart is hand-rolled inline SVG — no chart library, same rule
 * as the Rewards sparkline.
 */

type RangeKey = '7d' | '30d' | 'this_month' | 'last_month' | 'custom';

interface AnalyticsOverview {
  range: { from: string; to: string; label: string };
  revenue: {
    total_minor: number;
    avg_per_day_minor: number;
    prior_period_total_minor: number;
    delta_pct: number | null;
    daily: Array<{ date: string; total_minor: number }>;
  };
  peak_hours: {
    buckets: Array<{ dow: number; hour: number; session_count: number }>;
  };
  top_items: Array<{
    menu_item_id: string;
    name: string;
    count: number;
    revenue_minor: number;
  }>;
  avg_ticket: {
    minor: number;
    prior_period_minor: number;
    delta_pct: number | null;
  };
  diner_ratio: {
    new_count: number;
    repeat_count: number;
    anonymous_count: number;
  };
}

const RANGE_KEYS: RangeKey[] = ['7d', '30d', 'this_month', 'last_month', 'custom'];

function fmtRupees(minor: number): string {
  return (minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function customDefaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return isoDay(d);
}

function customDefaultTo(): string {
  return isoDay(new Date());
}

export function Analytics() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const [range, setRange] = useState<RangeKey>('30d');
  const [customFrom, setCustomFrom] = useState<string>(customDefaultFrom());
  const [customTo, setCustomTo] = useState<string>(customDefaultTo());

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const queryParams = useMemo(() => {
    const p = new URLSearchParams({ range });
    if (range === 'custom') {
      // Same iso-day convention as Rewards: start-of-day for `from`,
      // start of the next day for `to` so the picker's "to = today"
      // includes anything that landed later today.
      p.set('from', new Date(`${customFrom}T00:00:00Z`).toISOString());
      const toDate = new Date(`${customTo}T00:00:00Z`);
      toDate.setUTCDate(toDate.getUTCDate() + 1);
      p.set('to', toDate.toISOString());
    }
    return p.toString();
  }, [range, customFrom, customTo]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['analytics-overview', restaurantId, queryParams],
    queryFn: () =>
      api.get<AnalyticsOverview>(
        `/restaurants/${restaurantId}/dashboard/analytics-overview?${queryParams}`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 60_000,
  });

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('analytics.overview.pick_restaurant')}</p>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[12px] font-semibold text-s-muted uppercase tracking-wide inline-flex items-center gap-1.5">
              <BarChart3 size={14} />
              {t('analytics.overview.title')}
            </div>
            <h1 className="text-[28px] text-s-ink leading-tight font-semibold">
              {t('analytics.overview.title')}
            </h1>
            <p className="text-[12.5px] text-s-muted mt-1 max-w-[64ch]">
              {t('analytics.overview.subtitle')}
            </p>
          </div>
          <RangePicker
            range={range}
            onRange={setRange}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
          />
        </div>
      </header>

      {isLoading && (
        <p className="text-s-muted text-sm">{t('analytics.overview.loading')}</p>
      )}
      {isError && (
        <p className="text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 text-sm">
          {t('analytics.overview.load_error')}
        </p>
      )}

      {data && (
        <>
          {/* Row 1: revenue chart + revenue stat card */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2">
              <RevenueTrend daily={data.revenue.daily} />
            </div>
            <RevenueStatCard revenue={data.revenue} />
          </div>

          {/* Row 2: peak-hours heatmap */}
          <PeakHoursHeatmap buckets={data.peak_hours.buckets} />

          {/* Row 3: top items + diner ratio */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2">
              <TopItems items={data.top_items} />
            </div>
            <DinerRatio ratio={data.diner_ratio} />
          </div>

          {/* Row 4: avg ticket stat card, isolated */}
          <AvgTicketCard avgTicket={data.avg_ticket} />
        </>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Range picker                                                    */
/* ────────────────────────────────────────────────────────────────── */

interface RangePickerProps {
  range: RangeKey;
  onRange: (r: RangeKey) => void;
  customFrom: string;
  customTo: string;
  onCustomFrom: (v: string) => void;
  onCustomTo: (v: string) => void;
}

function RangePicker({
  range,
  onRange,
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
}: RangePickerProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-end gap-2 flex-wrap">
      <div className="inline-flex gap-1 rounded-md p-1 bg-s-bg border border-s-line">
        {RANGE_KEYS.map((r) => {
          const active = r === range;
          return (
            <button
              key={r}
              onClick={() => onRange(r)}
              className={clsx(
                'px-3 h-8 rounded-md text-[12.5px] font-semibold transition',
                active
                  ? 'bg-brand text-white'
                  : 'text-s-muted hover:text-s-ink hover:bg-white',
              )}
              aria-pressed={active}
            >
              {t(`analytics.overview.range.${r}`)}
            </button>
          );
        })}
      </div>
      {range === 'custom' && (
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10.5px] font-semibold text-s-muted uppercase tracking-wide">
              {t('analytics.overview.range_from')}
            </span>
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => onCustomFrom(e.target.value)}
              className="h-8 px-2 rounded-md border border-s-line bg-s-paper text-[12.5px]"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10.5px] font-semibold text-s-muted uppercase tracking-wide">
              {t('analytics.overview.range_to')}
            </span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(e) => onCustomTo(e.target.value)}
              className="h-8 px-2 rounded-md border border-s-line bg-s-paper text-[12.5px]"
            />
          </label>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Widget: revenue trend (bar chart, hand-rolled SVG)              */
/* ────────────────────────────────────────────────────────────────── */

function RevenueTrend({
  daily,
}: {
  daily: AnalyticsOverview['revenue']['daily'];
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...daily.map((d) => d.total_minor));
  const hasData = daily.some((d) => d.total_minor > 0);
  const width = 720;
  const height = 220;
  const paddingLeft = 44;
  const paddingRight = 12;
  const paddingTop = 12;
  const paddingBottom = 26;
  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;
  const gap = daily.length > 20 ? 1 : 2;
  const barW = daily.length ? (chartW - gap * (daily.length - 1)) / daily.length : 0;
  // Y-axis: pick a "nice" number for the top so the grid labels round
  // cleanly. Round the max up to the nearest whole rupee tier (100, 500, 1000…).
  const roundUp = (n: number): number => {
    if (n <= 100) return 100;
    const orders = 10 ** Math.floor(Math.log10(n));
    return Math.ceil(n / orders) * orders;
  };
  const niceMax = roundUp(max);
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => (niceMax / tickCount) * i);
  // X-axis: only label every Nth bar so labels don't collide on a
  // 30- or 90-day chart. Aim for ~6 labels total.
  const xEvery = Math.max(1, Math.ceil(daily.length / 6));

  return (
    <section className="bg-s-paper border border-s-line rounded-lg p-4 flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2 text-s-muted">
        <TrendingUp size={14} />
        <span className="font-semibold text-[12px] uppercase tracking-wide">
          {t('analytics.overview.revenue.heading')}
        </span>
      </div>
      {!hasData ? (
        <EmptyState
          title={t('analytics.overview.revenue.empty_title')}
          hint={t('analytics.overview.revenue.empty_hint')}
        />
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            height={height}
            preserveAspectRatio="xMinYMid meet"
            role="img"
            aria-label={t('analytics.overview.revenue.heading')}
          >
            {/* Y-axis grid + labels */}
            {yTicks.map((v, i) => {
              const y = paddingTop + chartH - (v / niceMax) * chartH;
              return (
                <g key={i}>
                  <line
                    x1={paddingLeft}
                    x2={width - paddingRight}
                    y1={y}
                    y2={y}
                    stroke="hsl(214 22% 91%)"
                    strokeDasharray={i === 0 ? undefined : '2 3'}
                  />
                  <text
                    x={paddingLeft - 6}
                    y={y}
                    dominantBaseline="middle"
                    textAnchor="end"
                    fontSize="10"
                    fill="hsl(215 14% 44%)"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    ₹{fmtRupees(v)}
                  </text>
                </g>
              );
            })}
            {/* Bars */}
            {daily.map((d, i) => {
              const h = niceMax === 0 ? 0 : (d.total_minor / niceMax) * chartH;
              const x = paddingLeft + i * (barW + gap);
              const y = paddingTop + chartH - h;
              return (
                <g key={d.date}>
                  <rect
                    x={x}
                    y={y}
                    width={Math.max(1, barW)}
                    height={Math.max(h > 0 ? 1 : 0, h)}
                    rx={1.5}
                    fill="hsl(153 43% 46%)"
                  >
                    <title>{`${d.date} — ₹${fmtRupees(d.total_minor)}`}</title>
                  </rect>
                </g>
              );
            })}
            {/* X-axis labels */}
            {daily.map((d, i) => {
              if (i % xEvery !== 0 && i !== daily.length - 1) return null;
              const x = paddingLeft + i * (barW + gap) + barW / 2;
              const y = height - 8;
              // Trim to MM-DD to keep the label narrow.
              const label = d.date.slice(5);
              return (
                <text
                  key={`x-${d.date}`}
                  x={x}
                  y={y}
                  textAnchor="middle"
                  fontSize="10"
                  fill="hsl(215 14% 44%)"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {label}
                </text>
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Widget: revenue stat card (total, avg, delta)                   */
/* ────────────────────────────────────────────────────────────────── */

function RevenueStatCard({
  revenue,
}: {
  revenue: AnalyticsOverview['revenue'];
}) {
  const { t } = useTranslation();
  return (
    <section className="bg-brand-wash border border-brand-line rounded-lg p-5 flex flex-col gap-3 h-full">
      <div className="text-[11px] font-semibold text-brand-700 uppercase tracking-wide">
        {t('analytics.overview.revenue.total_label')}
      </div>
      <div className="font-mono text-3xl font-bold text-s-ink tabular-nums leading-none">
        ₹{fmtRupees(revenue.total_minor)}
      </div>
      <DeltaPill delta={revenue.delta_pct} label={t('analytics.overview.revenue.delta_vs_prior')} />
      <div className="mt-2 pt-3 border-t border-brand-line">
        <div className="text-[11px] font-semibold text-s-muted uppercase tracking-wide">
          {t('analytics.overview.revenue.avg_label')}
        </div>
        <div className="font-mono text-xl font-bold text-s-ink tabular-nums mt-1">
          ₹{fmtRupees(revenue.avg_per_day_minor)}
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Widget: peak-hours heatmap (7×24)                               */
/* ────────────────────────────────────────────────────────────────── */

function PeakHoursHeatmap({
  buckets,
}: {
  buckets: AnalyticsOverview['peak_hours']['buckets'];
}) {
  const { t } = useTranslation();
  const grid: number[][] = Array.from({ length: 7 }, () =>
    new Array<number>(24).fill(0),
  );
  let max = 0;
  for (const b of buckets) {
    if (b.dow >= 0 && b.dow < 7 && b.hour >= 0 && b.hour < 24) {
      const row = grid[b.dow]!;
      row[b.hour] = b.session_count;
      if (b.session_count > max) max = b.session_count;
    }
  }
  const hasData = max > 0;
  // 24 columns, each 22px wide; 7 rows, each 22px tall. Plus left-labels + top-labels.
  const cell = 22;
  const gap = 2;
  const leftLabelW = 34;
  const topLabelH = 20;
  const w = leftLabelW + 24 * (cell + gap);
  const h = topLabelH + 7 * (cell + gap);
  const hourLabels = [0, 6, 12, 18];

  return (
    <section className="bg-s-paper border border-s-line rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-s-muted">
        <Clock size={14} />
        <span className="font-semibold text-[12px] uppercase tracking-wide">
          {t('analytics.overview.peak_hours.heading')}
        </span>
        <span className="text-[11.5px] text-s-faint">
          {t('analytics.overview.peak_hours.sub')}
        </span>
      </div>
      {!hasData ? (
        <EmptyState
          title={t('analytics.overview.peak_hours.empty_title')}
          hint={t('analytics.overview.peak_hours.empty_hint')}
        />
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${w} ${h}`}
            width="100%"
            height={h}
            preserveAspectRatio="xMinYMid meet"
            role="img"
            aria-label={t('analytics.overview.peak_hours.heading')}
          >
            {/* top labels: 00, 06, 12, 18 */}
            {hourLabels.map((hr) => {
              const x = leftLabelW + hr * (cell + gap) + cell / 2;
              return (
                <text
                  key={`hlbl-${hr}`}
                  x={x}
                  y={12}
                  textAnchor="middle"
                  fontSize="10"
                  fill="hsl(215 14% 44%)"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {String(hr).padStart(2, '0')}
                </text>
              );
            })}
            {/* rows */}
            {grid.map((row, dow) => {
              const y = topLabelH + dow * (cell + gap);
              return (
                <g key={dow}>
                  <text
                    x={leftLabelW - 6}
                    y={y + cell / 2}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize="10"
                    fill="hsl(215 14% 44%)"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {t(`analytics.overview.peak_hours.days.${dow}`)}
                  </text>
                  {row.map((v, hr) => {
                    // Intensity from 5% → 100% as spec calls out. Fall
                    // through to a bare-min opacity for the zero cells
                    // so the whole grid still reads as a grid.
                    const opacity = v === 0 ? 0.05 : 0.05 + (v / max) * 0.95;
                    const x = leftLabelW + hr * (cell + gap);
                    const dayLabel = t(`analytics.overview.peak_hours.days.${dow}`);
                    return (
                      <rect
                        key={hr}
                        x={x}
                        y={y}
                        width={cell}
                        height={cell}
                        rx={3}
                        fill="hsl(153 43% 46%)"
                        fillOpacity={opacity}
                      >
                        <title>
                          {t('analytics.overview.peak_hours.tooltip', {
                            day: dayLabel,
                            hour: String(hr).padStart(2, '0'),
                            count: v,
                          })}
                        </title>
                      </rect>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Widget: top selling items (horizontal bars)                     */
/* ────────────────────────────────────────────────────────────────── */

function TopItems({ items }: { items: AnalyticsOverview['top_items'] }) {
  const { t } = useTranslation();
  const max = items.length ? Math.max(...items.map((i) => i.count)) : 0;
  return (
    <section className="bg-s-paper border border-s-line rounded-lg p-4 flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2 text-s-muted">
        <Utensils size={14} />
        <span className="font-semibold text-[12px] uppercase tracking-wide">
          {t('analytics.overview.top_items.heading')}
        </span>
        <span className="text-[11.5px] text-s-faint">
          {t('analytics.overview.top_items.sub')}
        </span>
      </div>
      {items.length === 0 ? (
        <EmptyState
          title={t('analytics.overview.top_items.empty_title')}
          hint={t('analytics.overview.top_items.empty_hint')}
        />
      ) : (
        <div className="flex flex-col gap-1.5 mt-2">
          {items.map((it) => {
            const pct = max ? (it.count / max) * 100 : 0;
            return (
              <div
                key={it.menu_item_id}
                className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_auto] items-center gap-3 text-[12.5px]"
              >
                <span className="truncate text-s-ink font-semibold" title={it.name}>
                  {it.name}
                </span>
                <div className="relative h-5 bg-s-bg rounded overflow-hidden">
                  <div
                    className="h-full bg-brand transition-all"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="absolute inset-0 flex items-center pl-2 text-[11px] font-mono font-semibold text-s-ink mix-blend-luminosity">
                    {it.count}
                  </span>
                </div>
                <span className="font-mono tabular-nums text-right text-s-ink font-semibold min-w-[70px]">
                  ₹{fmtRupees(it.revenue_minor)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Widget: new vs repeat diner ratio                               */
/* ────────────────────────────────────────────────────────────────── */

function DinerRatio({ ratio }: { ratio: AnalyticsOverview['diner_ratio'] }) {
  const { t } = useTranslation();
  const hasData = ratio.new_count + ratio.repeat_count > 0;
  return (
    <section className="bg-s-paper border border-s-line rounded-lg p-4 flex flex-col gap-3 h-full">
      <div className="flex items-center gap-2 text-s-muted">
        <Users size={14} />
        <span className="font-semibold text-[12px] uppercase tracking-wide">
          {t('analytics.overview.diner_ratio.heading')}
        </span>
      </div>
      {!hasData && ratio.anonymous_count === 0 ? (
        <EmptyState
          title={t('analytics.overview.diner_ratio.empty_title')}
          hint={t('analytics.overview.diner_ratio.empty_hint')}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-brand-line bg-brand-wash p-3 flex flex-col">
              <div className="text-[10.5px] font-semibold text-brand-700 uppercase tracking-wide">
                {t('analytics.overview.diner_ratio.new_label')}
              </div>
              <div className="font-mono text-3xl font-bold text-s-ink tabular-nums mt-1 leading-none">
                {ratio.new_count}
              </div>
              <div className="text-[11px] text-s-muted mt-2 leading-snug">
                {t('analytics.overview.diner_ratio.new_hint')}
              </div>
            </div>
            <div className="rounded-md border border-s-line bg-s-bg p-3 flex flex-col">
              <div className="text-[10.5px] font-semibold text-s-muted uppercase tracking-wide">
                {t('analytics.overview.diner_ratio.repeat_label')}
              </div>
              <div className="font-mono text-3xl font-bold text-s-ink tabular-nums mt-1 leading-none">
                {ratio.repeat_count}
              </div>
              <div className="text-[11px] text-s-muted mt-2 leading-snug">
                {t('analytics.overview.diner_ratio.repeat_hint')}
              </div>
            </div>
          </div>
          {ratio.anonymous_count > 0 && (
            <div className="text-[11px] text-s-muted bg-s-bg border border-s-line rounded px-2 py-1.5 inline-block self-start">
              {t('analytics.overview.diner_ratio.anonymous_pill', {
                count: ratio.anonymous_count,
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Widget: avg ticket size stat card                               */
/* ────────────────────────────────────────────────────────────────── */

function AvgTicketCard({
  avgTicket,
}: {
  avgTicket: AnalyticsOverview['avg_ticket'];
}) {
  const { t } = useTranslation();
  return (
    <section className="bg-brand-wash border border-brand-line rounded-lg p-5 flex items-center justify-between gap-4 flex-wrap">
      <div>
        <div className="text-[11px] font-semibold text-brand-700 uppercase tracking-wide">
          {t('analytics.overview.avg_ticket.heading')}
        </div>
        <div className="font-mono text-3xl font-bold text-s-ink tabular-nums mt-1 leading-none">
          ₹{fmtRupees(avgTicket.minor)}
        </div>
        <p className="text-[11.5px] text-s-muted mt-2 max-w-[64ch]">
          {t('analytics.overview.avg_ticket.sub')}
        </p>
      </div>
      <DeltaPill delta={avgTicket.delta_pct} label={t('analytics.overview.avg_ticket.delta_vs_prior')} />
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*   Shared: delta pill + empty state                                */
/* ────────────────────────────────────────────────────────────────── */

function DeltaPill({ delta, label }: { delta: number | null; label: string }) {
  if (delta === null) {
    return (
      <span className="inline-flex items-center gap-1 self-start text-[11.5px] font-semibold text-s-muted bg-s-bg border border-s-line rounded-full px-2.5 h-6">
        — {label}
      </span>
    );
  }
  const positive = delta >= 0;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 self-start text-[11.5px] font-semibold rounded-full px-2.5 h-6',
        positive ? 'bg-sage-wash text-sage' : 'bg-danger-wash text-danger',
      )}
    >
      {positive ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
      <span className="font-mono tabular-nums">
        {positive ? '+' : ''}
        {delta.toFixed(1)}%
      </span>
      <span className="text-s-muted font-normal">{label}</span>
    </span>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-1.5">
      <p className="text-[13px] font-semibold text-s-ink">{title}</p>
      <p className="text-[12px] text-s-muted max-w-[36ch]">{hint}</p>
    </div>
  );
}
