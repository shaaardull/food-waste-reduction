import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Leaf,
  Download,
  Sparkles,
  Clock,
  Sliders,
  ShieldAlert,
  Utensils,
  Check,
  TrendingUp,
} from 'lucide-react';
import { clsx } from 'clsx';
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
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

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

  async function downloadPdf() {
    if (!restaurantId || !token || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const base = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1';
      const res = await fetch(
        `${base}/restaurants/${restaurantId}/dashboard/sustainability-report.pdf?range=${range}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(cd);
      const filename = match?.[1] ?? `plate-clean-sustainability-${range}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : t('analytics.pdf.download_error'),
      );
    } finally {
      setDownloading(false);
    }
  }

  if (!restaurantId)
    return <p className="text-s-muted text-sm">{t('analytics.pick_restaurant')}</p>;
  if (isLoading || !data) {
    return <p className="text-s-muted text-sm">{t('analytics.loading')}</p>;
  }

  const totals = data.totals;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="row spread items-end flex-wrap gap-2">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('app.nav.analytics')}
            </div>
            <h1 className="display text-[28px] text-s-ink leading-tight">
              {t('analytics.title')}
            </h1>
          </div>
          <div className="row gap-2 flex-wrap">
            <div className="row gap-1.5">
              {RANGES.map((r) => {
                const active = r === range;
                return (
                  <button
                    key={r}
                    onClick={() => setRange(r)}
                    className={clsx(
                      'chip transition',
                      active
                        ? 'bg-brand text-white'
                        : 'bg-s-paper border border-s-line text-s-muted hover:text-s-ink',
                    )}
                    aria-pressed={active}
                  >
                    {t(`analytics.range.${r}`)}
                  </button>
                );
              })}
            </div>
            <button
              onClick={downloadPdf}
              disabled={downloading}
              className="row gap-1.5 items-center chip bg-sage-wash text-sage hover:bg-sage hover:text-white transition disabled:opacity-50"
              title={t('analytics.pdf.download_hint') ?? undefined}
            >
              <Download size={12} />
              {downloading ? t('analytics.pdf.downloading') : t('analytics.pdf.download')}
            </button>
          </div>
        </div>
        <p className="text-[12.5px] text-s-muted">{t('analytics.blurb')}</p>
      </header>

      {downloadError && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {t('analytics.pdf.download_error')}: {downloadError}
        </p>
      )}

      {/* top-line stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<TrendingUp size={14} />}
          tone="info"
          label={t('analytics.stat.sessions')}
          value={String(totals.sessions)}
        />
        <StatCard
          icon={<Check size={14} />}
          tone="sage"
          label={t('analytics.stat.approval_rate')}
          value={pct(data.rates.approval_rate)}
          caption={t('analytics.stat.decided_n', { count: totals.decided })}
        />
        <StatCard
          icon={<Sparkles size={14} />}
          tone="saffron"
          label={t('analytics.stat.rewards_issued')}
          value={String(totals.rewards_issued)}
          caption={t('analytics.stat.redemption_rate', {
            rate: pct(data.rates.redemption_rate),
          })}
        />
        <StatCard
          icon={<Sliders size={14} />}
          tone="brand"
          label={t('analytics.stat.avg_score')}
          value={fmtScore(data.avg_final_score)}
          caption={t('analytics.stat.pending_n', {
            count: totals.pending_validation,
          })}
        />
      </div>

      {/* decision-time + decision-mix */}
      <div className="grid md:grid-cols-2 gap-3">
        <Section icon={<Clock size={14} />} label={t('analytics.decision_time.heading')}>
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
        </Section>

        <Section icon={<Sliders size={14} />} label={t('analytics.decision_mix.heading')}>
          <Pair
            term={t('analytics.decision_mix.approved')}
            value={String(totals.approved)}
            accent="sage"
          />
          <Pair
            term={t('analytics.decision_mix.adjusted')}
            value={String(totals.adjusted)}
            accent="amber"
          />
          <Pair
            term={t('analytics.decision_mix.rejected')}
            value={String(totals.rejected)}
            accent="danger"
          />
        </Section>
      </div>

      {/* sustainability hero */}
      <section className="card p-5 bg-sage-wash/40 border-sage/20 flex flex-col gap-4">
        <div className="row gap-2.5 items-center">
          <div className="w-10 h-10 rounded-md bg-sage-wash text-sage flex items-center justify-center">
            <Leaf size={18} />
          </div>
          <div>
            <div className="font-semibold text-[15px] text-sage">
              {t('analytics.sustainability.heading')}
            </div>
            <p className="text-[12px] text-s-muted leading-snug">
              {t('analytics.sustainability.blurb')}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <SustainabilityTile
            value={data.sustainability.kg_food_saved.toFixed(2)}
            label={t('analytics.sustainability.kg_food_saved')}
          />
          <SustainabilityTile
            value={data.sustainability.kg_co2e_saved.toFixed(2)}
            label={t('analytics.sustainability.kg_co2e_saved')}
          />
          <SustainabilityTile
            value={data.sustainability.trees_day_equivalent.toFixed(1)}
            label={t('analytics.sustainability.trees_day')}
          />
        </div>
      </section>

      {/* top dishes */}
      <Section icon={<Utensils size={14} />} label={t('analytics.top_dishes.heading')}>
        {data.top_dishes.length === 0 ? (
          <p className="text-[13px] text-s-muted">{t('analytics.top_dishes.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] text-s-muted dev uppercase tracking-wide">
                  <th className="text-left py-1.5 font-semibold">
                    {t('analytics.top_dishes.dish')}
                  </th>
                  <th className="text-left py-1.5 font-semibold">
                    {t('analytics.top_dishes.category')}
                  </th>
                  <th className="text-right py-1.5 font-semibold">
                    {t('analytics.top_dishes.orders')}
                  </th>
                  <th className="text-right py-1.5 font-semibold">
                    {t('analytics.top_dishes.avg_score')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.top_dishes.map((d) => (
                  <tr key={d.menu_item_id} className="border-t border-s-line">
                    <td className="py-1.5 text-s-ink">{d.name}</td>
                    <td className="py-1.5 text-s-muted capitalize">
                      {d.category ?? '—'}
                    </td>
                    <td className="py-1.5 text-right tnum">{d.orders}</td>
                    <td className="py-1.5 text-right tnum">
                      {Math.round(d.avg_final_score * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* fraud signals */}
      <Section icon={<ShieldAlert size={14} />} label={t('analytics.fraud.heading')}>
        {data.fraud_signals.length === 0 ? (
          <p className="text-[13px] text-s-muted">{t('analytics.fraud.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {data.fraud_signals.map((f) => (
              <li
                key={f.signal_type}
                className="row spread items-baseline border-t border-s-line/60 pt-1.5 first:border-t-0 first:pt-0 text-[12.5px]"
              >
                <span className="text-s-ink">{f.signal_type}</span>
                <span className="row gap-2 items-baseline">
                  {f.severity_counts.block > 0 && (
                    <span className="chip chip-danger">
                      {t('analytics.fraud.severity.block', {
                        count: f.severity_counts.block,
                      })}
                    </span>
                  )}
                  {f.severity_counts.warning > 0 && (
                    <span className="chip chip-amber">
                      {t('analytics.fraud.severity.warning', {
                        count: f.severity_counts.warning,
                      })}
                    </span>
                  )}
                  {f.severity_counts.info > 0 && (
                    <span className="chip chip-muted">
                      {t('analytics.fraud.severity.info', {
                        count: f.severity_counts.info,
                      })}
                    </span>
                  )}
                  <span className="tnum font-bold text-s-ink">{f.total}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </section>
  );
}

/* ----- pieces ----------------------------------------------------- */

interface StatCardProps {
  icon: React.ReactNode;
  tone: 'info' | 'sage' | 'saffron' | 'brand';
  label: string;
  value: string;
  caption?: string;
}

function StatCard({ icon, tone, label, value, caption }: StatCardProps) {
  const accent =
    tone === 'sage'
      ? 'text-sage'
      : tone === 'saffron'
        ? 'text-saffron-deep'
        : tone === 'info'
          ? 'text-info'
          : 'text-brand';
  return (
    <div className="stat flex flex-col gap-1.5">
      <div className={`row gap-1.5 items-center ${accent}`}>
        {icon}
        <span className="k dev uppercase tracking-wide">{label}</span>
      </div>
      <div className="v tnum">{value}</div>
      {caption && <div className="text-[11.5px] text-s-muted dev">{caption}</div>}
    </div>
  );
}

interface SectionProps {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}

function Section({ icon, label, children }: SectionProps) {
  return (
    <section className="bg-s-paper border border-s-line rounded-lg p-4 flex flex-col gap-2">
      <div className="row gap-2 items-center text-s-muted">
        {icon}
        <span className="font-semibold text-[12px] dev uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

interface PairProps {
  term: string;
  value: string;
  accent?: 'sage' | 'amber' | 'danger';
}

function Pair({ term, value, accent }: PairProps) {
  const cls =
    accent === 'sage'
      ? 'text-sage'
      : accent === 'amber'
        ? 'text-amber-deep'
        : accent === 'danger'
          ? 'text-danger'
          : 'text-s-ink';
  return (
    <div className="row spread items-baseline py-0.5 text-[13px]">
      <span className="text-s-muted">{term}</span>
      <span className={`tnum font-bold ${cls}`}>{value}</span>
    </div>
  );
}

function SustainabilityTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-md bg-paper border border-line p-3">
      <div className="tnum font-bold text-[22px] text-ink leading-none">{value}</div>
      <div className="text-[11.5px] text-muted dev mt-1 leading-tight">{label}</div>
    </div>
  );
}
