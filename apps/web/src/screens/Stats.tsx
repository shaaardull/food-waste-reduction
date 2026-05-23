import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';

type Range = '30d' | '90d' | 'all';

interface PublicStats {
  range: Range;
  period_days: number | null;
  restaurants_active: number;
  sessions_counted: number;
  k_anonymous: boolean;
  k_anonymity_floor: { restaurants: number; sessions: number };
  kg_food_saved: number | null;
  kg_co2e_saved: number | null;
  trees_day_equivalent: number | null;
  rewards_issued: number | null;
  rewards_redeemed: number | null;
  generated_at: string;
}

const RANGES: Range[] = ['30d', '90d', 'all'];

/**
 * Public marketing page at /stats. No auth, no PII. Aggregate scalars
 * across every restaurant on the platform — kg food saved, kg CO₂e
 * avoided, tree-day equivalent.
 *
 * Below the k-anonymity floor (set on the backend) every scalar is
 * null and we show a "checking back later" empty state instead of
 * accidentally exposing a single pilot restaurant's numbers.
 */
export function Stats() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<Range>('30d');

  const { data, isLoading } = useQuery({
    queryKey: ['public-stats', range],
    queryFn: () => api.get<PublicStats>(`/public/stats?range=${range}`),
    // Cache for 5 minutes — public scalars don't move fast and we
    // don't want every page view re-running the SQL aggregate.
    staleTime: 5 * 60_000,
  });

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-brand-700">
          {t('stats.title')}
        </h1>
        <p className="text-slate-600 text-sm">{t('stats.subtitle')}</p>
      </header>

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
            {t(`stats.range.${r}`)}
          </button>
        ))}
      </div>

      {isLoading || !data ? (
        <p className="text-slate-600 text-sm">{t('stats.loading')}</p>
      ) : !data.k_anonymous ? (
        <EmptyState
          floor={data.k_anonymity_floor}
          got={{
            restaurants: data.restaurants_active,
            sessions: data.sessions_counted,
          }}
          t={t}
        />
      ) : (
        <>
          <section className="rounded-2xl bg-emerald-50 border border-emerald-200 p-6 text-center space-y-1">
            <div className="text-5xl font-bold text-emerald-900">
              {data.kg_food_saved!.toFixed(2)}
            </div>
            <div className="text-sm text-emerald-800">
              {t('stats.hero_unit')}
            </div>
            <p className="text-xs text-emerald-800/70 pt-2">
              {t('stats.hero_sub', {
                restaurants: data.restaurants_active,
                sessions: data.sessions_counted,
              })}
            </p>
          </section>

          <div className="grid grid-cols-2 gap-3">
            <Stat
              label={t('stats.co2e_label')}
              value={`${data.kg_co2e_saved!.toFixed(2)} kg`}
            />
            <Stat
              label={t('stats.trees_label')}
              value={data.trees_day_equivalent!.toFixed(1)}
            />
            <Stat
              label={t('stats.rewards_issued_label')}
              value={String(data.rewards_issued)}
            />
            <Stat
              label={t('stats.rewards_redeemed_label')}
              value={String(data.rewards_redeemed)}
            />
          </div>

          <section className="text-xs text-slate-500 space-y-1">
            <p>{t('stats.methodology_1')}</p>
            <p>{t('stats.methodology_2')}</p>
          </section>

          <p className="text-[10px] text-slate-400">
            {t('stats.generated_at', {
              datetime: new Date(data.generated_at).toLocaleString(
                i18n.resolvedLanguage,
              ),
            })}
          </p>
        </>
      )}

      <footer className="pt-4 border-t border-slate-100 text-sm text-center">
        <Link to="/" className="text-brand-700 hover:underline">
          {t('stats.back_to_home')}
        </Link>
      </footer>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white border border-slate-200 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{value}</div>
    </div>
  );
}

interface EmptyStateProps {
  floor: { restaurants: number; sessions: number };
  got: { restaurants: number; sessions: number };
  t: ReturnType<typeof useTranslation>['t'];
}

function EmptyState({ floor, got, t }: EmptyStateProps) {
  return (
    <section className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm text-slate-700 space-y-2">
      <p className="font-medium">{t('stats.empty_title')}</p>
      <p className="text-slate-600">{t('stats.empty_blurb')}</p>
      <ul className="text-xs text-slate-500 list-disc pl-5">
        <li>
          {t('stats.empty_progress_restaurants', {
            got: got.restaurants,
            floor: floor.restaurants,
          })}
        </li>
        <li>
          {t('stats.empty_progress_sessions', {
            got: got.sessions,
            floor: floor.sessions,
          })}
        </li>
      </ul>
    </section>
  );
}
