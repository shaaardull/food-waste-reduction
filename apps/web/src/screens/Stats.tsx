import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Leaf, Sparkles, Ticket, Award, BarChart3 } from 'lucide-react';
import { api } from '../lib/api';
import { LangToggle } from '../components/LangToggle';

type Range = '30d' | '90d' | 'all';

interface PublicStats {
  range: Range;
  period_days: number | null;
  sessions_counted: number;
  // `restaurants_active` + `k_anonymity_floor` used to be here.
  // The API stopped returning them since the exact restaurant count
  // is business-sensitive at pilot scale (and the floor would leak
  // it by subtraction from the empty-state copy).
  k_anonymous: boolean;
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
    staleTime: 5 * 60_000,
  });

  return (
    <div className="d-screen flex flex-col min-h-full">
      {/* header */}
      <div className="px-5 pt-4 pb-2">
        <div className="spread">
          <Link
            to="/"
            className="row gap-1.5 items-center text-[13px] font-semibold text-muted hover:text-ink"
          >
            <ArrowLeft size={14} />
            <span>{t('stats.back_to_home')}</span>
          </Link>
          <LangToggle />
        </div>
        <h1 className="display text-[30px] mt-3.5 leading-tight">
          {t('stats.title')}
        </h1>
        <p className="text-sm text-muted mt-1.5 leading-snug">
          {t('stats.subtitle')}
        </p>
      </div>

      <div className="px-4 pb-8 flex flex-col gap-4">
        {/* range picker */}
        <div className="flex gap-1.5 flex-wrap">
          {RANGES.map((r) => {
            const active = r === range;
            return (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`chip transition ${
                  active
                    ? 'bg-brand text-white'
                    : 'bg-paper border border-line text-ink/80 hover:text-ink'
                }`}
                aria-pressed={active}
              >
                {t(`stats.range.${r}`)}
              </button>
            );
          })}
        </div>

        {isLoading || !data ? (
          <p className="text-muted text-sm py-8 text-center">{t('stats.loading')}</p>
        ) : !data.k_anonymous ? (
          <EmptyState t={t} />
        ) : (
          <>
            {/* sage hero */}
            <section className="card p-6 bg-sage-wash/40 border-sage/20 flex flex-col items-center text-center gap-2">
              <div className="w-12 h-12 rounded-md bg-sage-wash text-sage flex items-center justify-center">
                <Leaf size={22} />
              </div>
              <div className="tnum font-bold text-[56px] leading-none text-ink mt-1">
                {data.kg_food_saved!.toFixed(2)}
              </div>
              <div className="text-[13px] font-semibold text-sage uppercase tracking-wide dev">
                {t('stats.hero_unit')}
              </div>
              <p className="text-[12.5px] text-muted mt-1.5 max-w-[36ch]">
                {t('stats.hero_sub', { sessions: data.sessions_counted })}
              </p>
            </section>

            {/* 2x2 stat grid */}
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile
                icon={<Sparkles size={14} />}
                value={data.kg_co2e_saved!.toFixed(2)}
                unit="kg"
                label={t('stats.co2e_label')}
              />
              <StatTile
                icon={<Leaf size={14} />}
                value={data.trees_day_equivalent!.toFixed(1)}
                label={t('stats.trees_label')}
              />
              <StatTile
                icon={<Ticket size={14} />}
                value={String(data.rewards_issued)}
                label={t('stats.rewards_issued_label')}
              />
              <StatTile
                icon={<Award size={14} />}
                value={String(data.rewards_redeemed)}
                label={t('stats.rewards_redeemed_label')}
              />
            </div>

            {/* methodology footnotes */}
            <section className="card p-4 flex flex-col gap-2 bg-paper">
              <div className="row gap-2 items-center text-muted">
                <BarChart3 size={14} />
                <span className="font-semibold text-[12px] dev uppercase tracking-wide">
                  {t('stats.methodology_heading')}
                </span>
              </div>
              <p className="text-[12px] text-muted leading-snug">
                {t('stats.methodology_1')}
              </p>
              <p className="text-[12px] text-muted leading-snug">
                {t('stats.methodology_2')}
              </p>
            </section>

            <p className="text-[11px] text-muted/80 text-center">
              {t('stats.generated_at', {
                datetime: new Date(data.generated_at).toLocaleString(
                  i18n.resolvedLanguage,
                ),
              })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

interface StatTileProps {
  icon: React.ReactNode;
  value: string;
  unit?: string;
  label: string;
}

function StatTile({ icon, value, unit, label }: StatTileProps) {
  return (
    <div className="card-flat p-3.5 flex flex-col gap-1.5">
      <div className="row gap-1.5 items-center text-saffron-deep">
        {icon}
        <span className="dev text-[11.5px] font-semibold uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="tnum font-bold text-[24px] leading-none text-ink">
        {value}
        {unit && (
          <span className="text-[14px] text-muted font-semibold ml-1">{unit}</span>
        )}
      </div>
    </div>
  );
}

interface EmptyStateProps {
  t: ReturnType<typeof useTranslation>['t'];
}

function EmptyState({ t }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="art">
        <BarChart3 size={32} />
      </div>
      <p className="font-semibold text-ink text-[15px]">{t('stats.empty_title')}</p>
      <p className="text-[13px] text-muted mt-1.5 max-w-[40ch] leading-snug">
        {t('stats.empty_blurb')}
      </p>
    </div>
  );
}
