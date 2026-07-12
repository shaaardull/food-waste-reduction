import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Building2,
  Users,
  Zap,
  Leaf,
  Ticket,
  Receipt,
  ShieldAlert,
  AlertCircle,
  Bug,
  ChevronRight,
  X,
  Check,
  Edit3,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * PlatformCommandCenter — hidden `/-/platform` backdoor for the
 * platform owner. Access model:
 *   • The route is not linked from any nav; you have to know the URL.
 *   • Backend returns 404 (not 403) to non-admin JWTs, so a curl by
 *     staff who guessed the path can't confirm the endpoint exists.
 *   • Client-side we also short-circuit non-admin sessions to 404 so
 *     the tsx never renders admin chrome for the wrong role.
 *
 * Two tabs:
 *   • Analytics — headline scalars + restaurants leaderboard with
 *     drill-down. Range chips (7d/30d/90d/all).
 *   • Bug reports — cards, filter by status, click to edit status +
 *     add admin notes inline.
 */

type Range = '7d' | '30d' | '90d' | 'all';
const RANGES: Range[] = ['7d', '30d', '90d', 'all'];

type BugSeverity = 'low' | 'medium' | 'high' | 'critical';
type BugStatus = 'open' | 'triaging' | 'in_progress' | 'resolved' | 'wont_fix';
const BUG_STATUSES: BugStatus[] = [
  'open',
  'triaging',
  'in_progress',
  'resolved',
  'wont_fix',
];

interface PlatformSummary {
  restaurants_total: number;
  restaurants_active: number;
  diners_total: number;
  diners_active: number;
  sessions_total: number;
  sessions_rewarded: number;
  sessions_cancelled: number;
  validations_total: number;
  validations_approved: number;
  approval_rate: number | null;
  kg_food_saved: number;
  kg_co2e_saved: number;
  trees_day_equivalent: number;
  rewards_issued: number;
  rewards_redeemed: number;
  redemption_rate: number | null;
  bills_issued: number;
  revenue_paise: number;
  gst_paise: number;
  disputes_filed: number;
  disputes_resolved: number;
  fraud_signals_total: number;
  fraud_signals_blocked: number;
  bugs_open: number;
  bugs_critical_open: number;
}

interface PlatformAnalytics {
  range: Range;
  since: string;
  generated_at: string;
  summary: PlatformSummary;
  restaurants: Array<{
    restaurant_id: string;
    name: string;
    sessions: number;
    rewards: number;
    revenue_paise: number;
  }>;
}

interface Drilldown {
  restaurant: {
    id: string;
    name: string;
    slug: string;
    is_active: boolean;
    gstin: string | null;
    created_at: string;
  };
  range: Range;
  activity: {
    sessions_total: number;
    sessions_rewarded: number;
    sessions_cancelled: number;
    validations_total: number;
    validations_approved: number;
    validations_rejected: number;
    approval_rate: number | null;
  };
  sustainability: {
    kg_food_saved: number;
    kg_co2e_saved: number;
    trees_day_equivalent: number;
  };
  rewards: {
    issued: number;
    redeemed: number;
    redemption_rate: number | null;
  };
  revenue: { revenue_paise: number; gst_paise: number };
  disputes: { filed: number };
  staff: { on_roster: number; active_in_window: number };
}

interface BugRow {
  id: string;
  restaurant_id: string | null;
  restaurant_name: string | null;
  reported_by_user_id: string;
  reported_by_email: string | null;
  reported_by_display_name: string | null;
  title: string;
  description: string;
  severity: BugSeverity;
  status: BugStatus;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

function moneyINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function pct(n: number | null): string {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

export function PlatformCommandCenter() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, user } = useAuthStore();

  // Client-side 404 for non-admin sessions. Backend also 404s the
  // endpoints, but the render-time short-circuit means we don't
  // even flash the admin chrome for the wrong role.
  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const [tab, setTab] = useState<'analytics' | 'bugs'>('analytics');

  // Early returns AFTER all hooks — rules-of-hooks compliance.
  if (!token) return null;
  if (user && user.role !== 'admin') {
    return <NotFound />;
  }

  return (
    <div className="max-w-screen-xl mx-auto">
      <header className="flex flex-col gap-2 pb-4">
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
          <ShieldAlert size={12} />
          {t('platform.eyebrow')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('platform.title')}
        </h1>
        <p className="text-[13px] text-s-muted max-w-[62ch]">
          {t('platform.blurb')}
        </p>
      </header>

      <div className="row gap-1.5 pb-4 border-b border-s-line">
        <TabButton
          active={tab === 'analytics'}
          onClick={() => setTab('analytics')}
        >
          {t('platform.tab_analytics')}
        </TabButton>
        <TabButton active={tab === 'bugs'} onClick={() => setTab('bugs')}>
          {t('platform.tab_bugs')}
        </TabButton>
      </div>

      {tab === 'analytics' ? <AnalyticsTab /> : <BugsTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-4 h-9 rounded-md font-semibold text-[13px] transition',
        active
          ? 'bg-brand text-white'
          : 'text-s-muted hover:text-s-ink hover:bg-s-bg',
      )}
    >
      {children}
    </button>
  );
}

function NotFound() {
  return (
    <div className="max-w-md mx-auto pt-16 text-center">
      <h1 className="display text-[24px] text-s-ink">404</h1>
      <p className="text-[13px] text-s-muted mt-1">Not found.</p>
    </div>
  );
}

// ── Analytics tab ────────────────────────────────────────────────

function AnalyticsTab() {
  const { t } = useTranslation();
  const { token } = useAuthStore();
  const [range, setRange] = useState<Range>('30d');
  const [drilldownFor, setDrilldownFor] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const { data, isLoading, error } = useQuery<PlatformAnalytics>({
    queryKey: ['platform-analytics', range],
    queryFn: () =>
      api.get<PlatformAnalytics>(
        `/admin/platform/analytics?range=${range}`,
        token,
      ),
    enabled: Boolean(token),
  });

  return (
    <section className="flex flex-col gap-5 pt-4">
      <div className="row gap-1.5">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={clsx(
              'chip transition',
              range === r ? 'chip-brand' : 'chip-muted hover:bg-s-bg',
            )}
          >
            {t(`platform.range_${r}`)}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {(error as Error).message}
        </p>
      )}

      {isLoading || !data ? (
        <p className="text-s-muted text-[13px]">{t('platform.loading')}</p>
      ) : (
        <>
          <SummaryGrid summary={data.summary} t={t} />

          <section className="flex flex-col gap-3">
            <div className="row spread items-baseline">
              <h2 className="display text-[20px] text-s-ink">
                {t('platform.restaurants_heading')}
              </h2>
              <span className="text-[12px] text-s-muted">
                {t('platform.restaurants_count', {
                  count: data.restaurants.length,
                })}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.restaurants.map((r) => (
                <button
                  key={r.restaurant_id}
                  type="button"
                  onClick={() =>
                    setDrilldownFor({ id: r.restaurant_id, name: r.name })
                  }
                  className="rounded-lg border border-s-line bg-s-paper p-4 flex flex-col gap-2 text-left hover:border-brand transition"
                >
                  <div className="row spread items-start">
                    <div className="font-bold text-[14px] text-s-ink line-clamp-2">
                      {r.name}
                    </div>
                    <ChevronRight size={14} className="text-s-muted mt-0.5" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[12px]">
                    <div>
                      <div className="tnum font-bold text-[15px] text-s-ink">
                        {r.sessions}
                      </div>
                      <div className="text-s-muted">
                        {t('platform.leaderboard_sessions')}
                      </div>
                    </div>
                    <div>
                      <div className="tnum font-bold text-[15px] text-s-ink">
                        {r.rewards}
                      </div>
                      <div className="text-s-muted">
                        {t('platform.leaderboard_rewards')}
                      </div>
                    </div>
                    <div>
                      <div className="tnum font-bold text-[15px] text-s-ink">
                        {moneyINR(r.revenue_paise)}
                      </div>
                      <div className="text-s-muted">
                        {t('platform.leaderboard_revenue')}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {drilldownFor && (
        <DrilldownModal
          restaurantId={drilldownFor.id}
          restaurantName={drilldownFor.name}
          range={range}
          onClose={() => setDrilldownFor(null)}
        />
      )}
    </section>
  );
}

function SummaryGrid({
  summary,
  t,
}: {
  summary: PlatformSummary;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const tiles = [
    {
      icon: <Building2 size={16} />,
      label: t('platform.stat_restaurants'),
      value: `${summary.restaurants_active}/${summary.restaurants_total}`,
      sub: t('platform.stat_restaurants_sub'),
      tone: 'brand',
    },
    {
      icon: <Users size={16} />,
      label: t('platform.stat_diners'),
      value: summary.diners_active.toLocaleString(),
      sub: t('platform.stat_diners_sub', {
        total: summary.diners_total,
      }),
      tone: 'brand',
    },
    {
      icon: <Zap size={16} />,
      label: t('platform.stat_sessions'),
      value: summary.sessions_total.toLocaleString(),
      sub: t('platform.stat_sessions_sub', {
        rewarded: summary.sessions_rewarded,
        cancelled: summary.sessions_cancelled,
      }),
      tone: 'saffron',
    },
    {
      icon: <Check size={16} />,
      label: t('platform.stat_approval_rate'),
      value: pct(summary.approval_rate),
      sub: t('platform.stat_approval_rate_sub', {
        approved: summary.validations_approved,
        total: summary.validations_total,
      }),
      tone: 'sage',
    },
    {
      icon: <Leaf size={16} />,
      label: t('platform.stat_kg_saved'),
      value: `${summary.kg_food_saved.toFixed(1)} kg`,
      sub: t('platform.stat_kg_saved_sub', {
        co2: summary.kg_co2e_saved.toFixed(1),
      }),
      tone: 'sage',
    },
    {
      icon: <Ticket size={16} />,
      label: t('platform.stat_rewards'),
      value: `${summary.rewards_redeemed}/${summary.rewards_issued}`,
      sub: t('platform.stat_rewards_sub', {
        pct: pct(summary.redemption_rate),
      }),
      tone: 'brand',
    },
    {
      icon: <Receipt size={16} />,
      label: t('platform.stat_revenue'),
      value: moneyINR(summary.revenue_paise),
      sub: t('platform.stat_revenue_sub', {
        gst: moneyINR(summary.gst_paise),
        bills: summary.bills_issued,
      }),
      tone: 'brand',
    },
    {
      icon: <AlertCircle size={16} />,
      label: t('platform.stat_disputes'),
      value: `${summary.disputes_resolved}/${summary.disputes_filed}`,
      sub: t('platform.stat_disputes_sub'),
      tone: 'amber',
    },
    {
      icon: <ShieldAlert size={16} />,
      label: t('platform.stat_fraud'),
      value: summary.fraud_signals_blocked.toString(),
      sub: t('platform.stat_fraud_sub', {
        total: summary.fraud_signals_total,
      }),
      tone: 'danger',
    },
    {
      icon: <Bug size={16} />,
      label: t('platform.stat_bugs'),
      value: summary.bugs_open.toString(),
      sub: t('platform.stat_bugs_sub', {
        critical: summary.bugs_critical_open,
      }),
      tone: 'danger',
    },
  ];
  return (
    <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {tiles.map((tile, i) => (
        <div
          key={i}
          className="rounded-lg border border-s-line bg-s-paper p-3 flex flex-col gap-1"
        >
          <div className="row gap-1.5 items-center text-s-muted">
            {tile.icon}
            <div className="text-[11.5px] font-semibold uppercase tracking-wide dev">
              {tile.label}
            </div>
          </div>
          <div className="tnum font-bold text-[22px] text-s-ink leading-tight">
            {tile.value}
          </div>
          <div className="text-[11.5px] text-s-muted leading-snug">
            {tile.sub}
          </div>
        </div>
      ))}
    </section>
  );
}

function DrilldownModal({
  restaurantId,
  restaurantName,
  range,
  onClose,
}: {
  restaurantId: string;
  restaurantName: string;
  range: Range;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { token } = useAuthStore();
  const { data, isLoading, error } = useQuery<Drilldown>({
    queryKey: ['platform-drilldown', restaurantId, range],
    queryFn: () =>
      api.get<Drilldown>(
        `/admin/platform/restaurants/${restaurantId}/analytics?range=${range}`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
  });

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[640px] max-h-[92vh] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('platform.drilldown_eyebrow', { range: t(`platform.range_${range}`) })}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {restaurantName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">
          {isLoading || !data ? (
            <p className="text-s-muted text-[13px]">{t('platform.loading')}</p>
          ) : error ? (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {(error as Error).message}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="row gap-2 flex-wrap text-[12px]">
                <span className={clsx('chip', data.restaurant.is_active ? 'chip-sage' : 'chip-muted')}>
                  {data.restaurant.is_active
                    ? t('platform.restaurant_active')
                    : t('platform.restaurant_inactive')}
                </span>
                {data.restaurant.gstin && (
                  <span className="chip chip-muted font-mono tracking-wide">
                    GSTIN {data.restaurant.gstin}
                  </span>
                )}
              </div>

              <DrilldownGroup
                heading={t('platform.drill_activity')}
                items={[
                  {
                    label: t('platform.drill_sessions'),
                    value: data.activity.sessions_total,
                  },
                  {
                    label: t('platform.drill_rewarded'),
                    value: data.activity.sessions_rewarded,
                  },
                  {
                    label: t('platform.drill_cancelled'),
                    value: data.activity.sessions_cancelled,
                  },
                  {
                    label: t('platform.drill_approval_rate'),
                    value: pct(data.activity.approval_rate),
                  },
                  {
                    label: t('platform.drill_validations'),
                    value: `${data.activity.validations_approved}/${data.activity.validations_total}`,
                  },
                  {
                    label: t('platform.drill_rejected'),
                    value: data.activity.validations_rejected,
                  },
                ]}
              />

              <DrilldownGroup
                heading={t('platform.drill_sustainability')}
                items={[
                  {
                    label: t('platform.drill_kg_food'),
                    value: `${data.sustainability.kg_food_saved.toFixed(2)} kg`,
                  },
                  {
                    label: t('platform.drill_kg_co2'),
                    value: `${data.sustainability.kg_co2e_saved.toFixed(2)} kg`,
                  },
                  {
                    label: t('platform.drill_trees'),
                    value: data.sustainability.trees_day_equivalent.toFixed(1),
                  },
                ]}
              />

              <DrilldownGroup
                heading={t('platform.drill_rewards')}
                items={[
                  {
                    label: t('platform.drill_issued'),
                    value: data.rewards.issued,
                  },
                  {
                    label: t('platform.drill_redeemed'),
                    value: data.rewards.redeemed,
                  },
                  {
                    label: t('platform.drill_redemption_rate'),
                    value: pct(data.rewards.redemption_rate),
                  },
                ]}
              />

              <DrilldownGroup
                heading={t('platform.drill_finance')}
                items={[
                  {
                    label: t('platform.drill_revenue'),
                    value: moneyINR(data.revenue.revenue_paise),
                  },
                  {
                    label: t('platform.drill_gst'),
                    value: moneyINR(data.revenue.gst_paise),
                  },
                ]}
              />

              <DrilldownGroup
                heading={t('platform.drill_people')}
                items={[
                  {
                    label: t('platform.drill_disputes_filed'),
                    value: data.disputes.filed,
                  },
                  {
                    label: t('platform.drill_staff_on_roster'),
                    value: data.staff.on_roster,
                  },
                  {
                    label: t('platform.drill_staff_active'),
                    value: data.staff.active_in_window,
                  },
                ]}
              />
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-s-line">
          <button
            onClick={onClose}
            className="btn btn-outline w-full min-h-[42px] text-[14px]"
          >
            {t('platform.drilldown_close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DrilldownGroup({
  heading,
  items,
}: {
  heading: string;
  items: Array<{ label: string; value: string | number }>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11.5px] font-semibold text-s-muted dev uppercase tracking-wide">
        {heading}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
        {items.map((it, i) => (
          <div
            key={i}
            className="rounded-md border border-s-line bg-s-paper px-3 py-2"
          >
            <div className="text-[11.5px] text-s-muted">{it.label}</div>
            <div className="tnum font-bold text-[15px] text-s-ink">
              {it.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Bug reports tab ──────────────────────────────────────────────

function BugsTab() {
  const { t } = useTranslation();
  const { token } = useAuthStore();
  const [statusFilter, setStatusFilter] = useState<'all' | BugStatus>('open');

  const { data, isLoading, error } = useQuery<BugRow[]>({
    queryKey: ['admin-bug-reports', statusFilter],
    queryFn: () =>
      api.get<BugRow[]>(
        `/admin/platform/bug-reports${statusFilter === 'all' ? '' : `?status=${statusFilter}`}`,
        token,
      ),
    enabled: Boolean(token),
    refetchInterval: 60_000,
  });

  return (
    <section className="flex flex-col gap-4 pt-4">
      <div className="row gap-1.5 flex-wrap">
        {(['all', ...BUG_STATUSES] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={clsx(
              'chip transition',
              statusFilter === s ? 'chip-brand' : 'chip-muted hover:bg-s-bg',
            )}
          >
            {t(`platform.bug_filter_${s}`)}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {(error as Error).message}
        </p>
      )}

      {isLoading || !data ? (
        <p className="text-s-muted text-[13px]">{t('platform.loading')}</p>
      ) : data.length === 0 ? (
        <div className="empty rounded-lg border border-s-line bg-s-paper">
          <div className="art">
            <Bug size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {t('platform.bugs_empty_title')}
          </p>
          <p className="text-[13px] text-s-muted mt-1.5 max-w-[42ch]">
            {t('platform.bugs_empty_blurb')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {data.map((row) => (
            <BugCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function BugCard({ row }: { row: BugRow }) {
  const { t } = useTranslation();
  const { token } = useAuthStore();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<BugStatus>(row.status);
  const [notes, setNotes] = useState(row.admin_notes ?? '');
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch<BugRow>(
        `/admin/platform/bug-reports/${row.id}`,
        { status, admin_notes: notes.trim() || null },
        token,
      ),
    onSuccess: () => {
      setEditing(false);
      setSavedFlash(true);
      void qc.invalidateQueries({ queryKey: ['admin-bug-reports'] });
      setTimeout(() => setSavedFlash(false), 2_500);
    },
    onError: (err: ApiException) => {
      setError(err.message ?? t('platform.bug_err_generic'));
    },
  });

  const created = new Date(row.created_at).toLocaleString();
  const reporter = row.reported_by_display_name ?? row.reported_by_email ?? '—';

  return (
    <article className="rounded-lg border border-s-line bg-s-paper p-4 flex flex-col gap-3">
      <div className="row spread items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-bold text-[15px] text-s-ink line-clamp-2">
            {row.title}
          </div>
          <div className="text-[11.5px] text-s-muted mt-0.5">
            {reporter} · {row.restaurant_name ?? t('platform.bug_no_restaurant')}
          </div>
        </div>
        <div className="row gap-1 flex-shrink-0">
          <span className={clsx('chip', severityChipClass(row.severity))}>
            {t(`bug_report.severity_${row.severity}`)}
          </span>
        </div>
      </div>
      <p className="text-[13px] text-s-ink whitespace-pre-wrap line-clamp-4 leading-snug">
        {row.description}
      </p>

      <div className="row spread items-center pt-2 border-t border-s-line/60">
        {editing ? (
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as BugStatus)}
            className="input mt-0 min-h-[32px] text-[12.5px] font-semibold"
          >
            {BUG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`bug_report.status_${s}`)}
              </option>
            ))}
          </select>
        ) : (
          <span className={clsx('chip', statusChipClass(row.status))}>
            {t(`bug_report.status_${row.status}`)}
          </span>
        )}
        <span className="text-[11.5px] text-s-muted">{created}</span>
      </div>

      {editing ? (
        <>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('platform.bug_notes_placeholder')}
            className="input mt-0 resize-none text-[13px]"
          />
          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}
          <div className="row gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setStatus(row.status);
                setNotes(row.admin_notes ?? '');
                setError(null);
              }}
              className="btn btn-outline flex-1 min-h-[36px] text-[12.5px]"
            >
              {t('platform.bug_cancel')}
            </button>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="btn btn-primary flex-1 min-h-[36px] text-[12.5px] disabled:opacity-55"
            >
              {save.isPending
                ? t('platform.bug_saving')
                : t('platform.bug_save')}
            </button>
          </div>
        </>
      ) : (
        <>
          {row.admin_notes && (
            <div className="text-[12.5px] text-s-ink bg-s-bg rounded-md px-2.5 py-1.5 border border-s-line/60 whitespace-pre-wrap">
              <span className="font-semibold">
                {t('bug_report.admin_note_label')}:
              </span>{' '}
              {row.admin_notes}
            </div>
          )}
          <div className="row gap-2 items-center">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="btn btn-outline min-h-[34px] text-[12.5px]"
            >
              <Edit3 size={12} /> {t('platform.bug_edit')}
            </button>
            {savedFlash && (
              <span className="row gap-1 items-center text-[12px] font-semibold text-sage">
                <Check size={12} /> {t('platform.bug_saved')}
              </span>
            )}
          </div>
        </>
      )}
    </article>
  );
}

function severityChipClass(s: BugSeverity): string {
  switch (s) {
    case 'low':
      return 'chip-sage';
    case 'medium':
      return 'chip-info';
    case 'high':
      return 'chip-amber';
    case 'critical':
      return 'chip-danger';
  }
}
function statusChipClass(s: BugStatus): string {
  switch (s) {
    case 'open':
      return 'chip-amber';
    case 'triaging':
      return 'chip-info';
    case 'in_progress':
      return 'chip-brand';
    case 'resolved':
      return 'chip-sage';
    case 'wont_fix':
      return 'chip-muted';
  }
}
