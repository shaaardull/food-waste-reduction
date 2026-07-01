import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, X, ListChecks, Gauge } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface SummaryData {
  range: string;
  sessions: number;
  rewarded: number;
  rejected: number;
  pending_validation: number;
  avg_final_score: number | null;
}

/**
 * Summary — the staff landing surface after sign-in. Four headline
 * stats over the last 7 days + a brand-coloured CTA to the queue if
 * anything's waiting on a decision.
 */
export function Summary() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data } = useQuery({
    queryKey: ['summary', restaurantId],
    queryFn: () =>
      api.get<SummaryData>(`/restaurants/${restaurantId}/dashboard/summary?range=7d`, token),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 30_000,
  });

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('summary.pick_restaurant')}</p>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.nav.summary')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('summary.title')}
        </h1>
      </header>

      {/* pending queue CTA — only shows when there's actually work */}
      {data && data.pending_validation > 0 && (
        <Link
          to="/validations"
          className="card p-4 row gap-3 items-center bg-brand-wash border-brand/20 hover:bg-brand-wash/80 transition"
        >
          <div className="w-10 h-10 rounded-md bg-brand text-white flex items-center justify-center">
            <ListChecks size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[15px] text-brand">
              {t('summary.pending_review_cta', { count: data.pending_validation })}
            </div>
          </div>
          <ArrowRight size={18} className="text-brand" />
        </Link>
      )}

      {/* 4-stat headline */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          icon={<Gauge size={14} />}
          tone="info"
          label={t('summary.stat.sessions')}
          value={data?.sessions ?? '…'}
        />
        <StatTile
          icon={<Check size={14} />}
          tone="sage"
          label={t('summary.stat.rewarded')}
          value={data?.rewarded ?? '…'}
        />
        <StatTile
          icon={<X size={14} />}
          tone="danger"
          label={t('summary.stat.rejected')}
          value={data?.rejected ?? '…'}
        />
        <StatTile
          icon={<Gauge size={14} />}
          tone="brand"
          label={t('summary.stat.avg_score')}
          value={
            data?.avg_final_score != null
              ? `${Math.round(data.avg_final_score * 100)}%`
              : '—'
          }
        />
      </div>
    </section>
  );
}

interface StatTileProps {
  icon: React.ReactNode;
  tone: 'info' | 'sage' | 'danger' | 'brand';
  label: string;
  value: number | string;
}

function StatTile({ icon, tone, label, value }: StatTileProps) {
  const accent =
    tone === 'sage'
      ? 'text-sage'
      : tone === 'danger'
        ? 'text-danger'
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
    </div>
  );
}
