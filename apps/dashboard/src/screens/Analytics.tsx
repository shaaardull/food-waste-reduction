import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

type Range = '7d' | '30d' | '90d';

interface AnalyticsResponse {
  range: Range;
  period_days: number;
  totals: {
    sessions: number;
    approved: number;
    adjusted: number;
    rejected: number;
    decided: number;
    pending_validation: number;
    rewards_issued: number;
    rewards_redeemed: number;
  };
  rates: {
    approval_rate: number | null;
    redemption_rate: number | null;
  };
  avg_final_score: number | null;
  decision_latency_ms: {
    p50: number | null;
    p95: number | null;
    count: number;
  };
  top_dishes: Array<{
    menu_item_id: string;
    name: string;
    category: string | null;
    orders: number;
    avg_final_score: number;
  }>;
  fraud_signals: Array<{
    signal_type: string;
    severity_counts: { info: number; warning: number; block: number };
    total: number;
  }>;
  sustainability: {
    kg_food_saved: number;
    kg_co2e_saved: number;
    trees_day_equivalent: number;
    sessions_counted: number;
  };
}

const RANGES: Range[] = ['7d', '30d', '90d'];

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function fmtScore(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function Analytics() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const [range, setRange] = useState<Range>('7d');

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', restaurantId, range],
    queryFn: () =>
      api.get<AnalyticsResponse>(
        `/restaurants/${restaurantId}/dashboard/analytics?range=${range}`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 60_000,
  });

  if (!restaurantId)
    return <p className="text-slate-600">{t('analytics.pick_restaurant')}</p>;
  if (isLoading || !data)
    return <p className="text-slate-600">{t('analytics.loading')}</p>;

  const totals = data.totals;

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold">{t('analytics.title')}</h1>
        <div className="flex gap-1 text-sm">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 rounded-md border ${
                r === range
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'border-slate-300 hover:border-brand-400'
              }`}
            >
              {t(`analytics.range.${r}`)}
            </button>
          ))}
        </div>
      </header>

      <p className="text-xs text-slate-500">{t('analytics.blurb')}</p>

      {/* Top-line cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={t('analytics.stat.sessions')} value={String(totals.sessions)} />
        <Stat
          label={t('analytics.stat.approval_rate')}
          value={pct(data.rates.approval_rate)}
          caption={t('analytics.stat.decided_n', { count: totals.decided })}
        />
        <Stat
          label={t('analytics.stat.rewards_issued')}
          value={String(totals.rewards_issued)}
          caption={t('analytics.stat.redemption_rate', {
            rate: pct(data.rates.redemption_rate),
          })}
        />
        <Stat
          label={t('analytics.stat.avg_score')}
          value={fmtScore(data.avg_final_score)}
          caption={t('analytics.stat.pending_n', {
            count: totals.pending_validation,
          })}
        />
      </div>

      {/* Decision time + decision mix */}
      <div className="grid md:grid-cols-2 gap-3">
        <section className="rounded-lg bg-white border border-slate-200 p-3 text-sm">
          <h2 className="font-medium mb-2">{t('analytics.decision_time.heading')}</h2>
          <dl className="space-y-1 text-slate-700">
            <Pair
              term={t('analytics.decision_time.p50')}
              value={fmtMs(data.decision_latency_ms.p50)}
            />
            <Pair
              term={t('analytics.decision_time.p95')}
              value={fmtMs(data.decision_latency_ms.p95)}
            />
            <Pair
              term={t('analytics.decision_time.n')}
              value={String(data.decision_latency_ms.count)}
            />
          </dl>
        </section>

        <section className="rounded-lg bg-white border border-slate-200 p-3 text-sm">
          <h2 className="font-medium mb-2">{t('analytics.decision_mix.heading')}</h2>
          <dl className="space-y-1 text-slate-700">
            <Pair
              term={t('analytics.decision_mix.approved')}
              value={String(totals.approved)}
            />
            <Pair
              term={t('analytics.decision_mix.adjusted')}
              value={String(totals.adjusted)}
            />
            <Pair
              term={t('analytics.decision_mix.rejected')}
              value={String(totals.rejected)}
            />
          </dl>
        </section>
      </div>

      {/* Sustainability */}
      <section className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm">
        <h2 className="font-medium text-emerald-900 mb-1">
          {t('analytics.sustainability.heading')}
        </h2>
        <p className="text-xs text-emerald-800/80 mb-2">
          {t('analytics.sustainability.blurb')}
        </p>
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label={t('analytics.sustainability.kg_food_saved')}
            value={data.sustainability.kg_food_saved.toFixed(2)}
            kind="green"
          />
          <Stat
            label={t('analytics.sustainability.kg_co2e_saved')}
            value={data.sustainability.kg_co2e_saved.toFixed(2)}
            kind="green"
          />
          <Stat
            label={t('analytics.sustainability.trees_day')}
            value={data.sustainability.trees_day_equivalent.toFixed(1)}
            kind="green"
          />
        </div>
      </section>

      {/* Top dishes */}
      <section className="rounded-lg bg-white border border-slate-200 p-3 text-sm">
        <h2 className="font-medium mb-2">{t('analytics.top_dishes.heading')}</h2>
        {data.top_dishes.length === 0 ? (
          <p className="text-slate-500 text-xs">{t('analytics.top_dishes.empty')}</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="font-normal py-1">{t('analytics.top_dishes.dish')}</th>
                <th className="font-normal py-1">
                  {t('analytics.top_dishes.category')}
                </th>
                <th className="font-normal py-1 text-right">
                  {t('analytics.top_dishes.orders')}
                </th>
                <th className="font-normal py-1 text-right">
                  {t('analytics.top_dishes.avg_score')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.top_dishes.map((d) => (
                <tr key={d.menu_item_id} className="border-t border-slate-100">
                  <td className="py-1">{d.name}</td>
                  <td className="py-1 text-slate-600">{d.category ?? '—'}</td>
                  <td className="py-1 text-right">{d.orders}</td>
                  <td className="py-1 text-right">{Math.round(d.avg_final_score * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Fraud signals */}
      <section className="rounded-lg bg-white border border-slate-200 p-3 text-sm">
        <h2 className="font-medium mb-2">{t('analytics.fraud.heading')}</h2>
        {data.fraud_signals.length === 0 ? (
          <p className="text-slate-500 text-xs">{t('analytics.fraud.empty')}</p>
        ) : (
          <ul className="space-y-1">
            {data.fraud_signals.map((f) => (
              <li
                key={f.signal_type}
                className="flex items-baseline justify-between border-t border-slate-100 pt-1 text-xs"
              >
                <span>{f.signal_type}</span>
                <span className="text-slate-600">
                  {f.severity_counts.block > 0 && (
                    <span className="text-red-700 mr-2">
                      {t('analytics.fraud.severity.block', {
                        count: f.severity_counts.block,
                      })}
                    </span>
                  )}
                  {f.severity_counts.warning > 0 && (
                    <span className="text-amber-700 mr-2">
                      {t('analytics.fraud.severity.warning', {
                        count: f.severity_counts.warning,
                      })}
                    </span>
                  )}
                  {f.severity_counts.info > 0 && (
                    <span className="text-slate-500 mr-2">
                      {t('analytics.fraud.severity.info', {
                        count: f.severity_counts.info,
                      })}
                    </span>
                  )}
                  <span className="font-mono">{f.total}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  caption?: string;
  kind?: 'default' | 'green';
}

function Stat({ label, value, caption, kind = 'default' }: StatProps) {
  const bg =
    kind === 'green'
      ? 'bg-emerald-100 border-emerald-200 text-emerald-900'
      : 'bg-white border-slate-200 text-slate-900';
  return (
    <div className={`rounded-lg border p-3 ${bg}`}>
      <div className="text-xs opacity-75">{label}</div>
      <div className="text-2xl font-semibold leading-tight">{value}</div>
      {caption && <div className="text-xs opacity-75 mt-0.5">{caption}</div>}
    </div>
  );
}

function Pair({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}
