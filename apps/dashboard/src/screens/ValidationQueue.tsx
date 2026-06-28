import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ListChecks,
  ShieldAlert,
  HelpCircle,
  AlertTriangle,
  Clock,
  ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface PendingItem {
  session_id: string;
  table_code: string;
  score: number;
  score_age_seconds: number;
  before_image_url: string;
  after_image_url: string;
  ordered_items: Array<{ name: string; quantity: number; portion_size: string | null }>;
  model_confidence: number | null;
  suspicious: boolean;
  fraud_signals: Array<{ signal_type: string; severity: string }>;
}

/**
 * Validation queue — staff triage table.
 *
 * Each row is a 6-column .vrow grid: status badge (56) · before/after
 * thumbnails (92) · table+items (1fr) · signal chips (150) · score% (96)
 * · review action (112). The whole row is a Link so a staff member can
 * just click through fast.
 *
 * Polls every 5s — these are decisions a diner is waiting on, so
 * stale data costs trust.
 */
export function ValidationQueue() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['pending', restaurantId],
    queryFn: () =>
      api.get<PendingItem[]>(`/restaurants/${restaurantId}/validations/pending`, token),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 5_000,
  });

  function ageLabel(s: number): string {
    if (s < 60) return t('queue.age.seconds', { count: s });
    return t('queue.age.minutes', { count: Math.floor(s / 60) });
  }

  if (!restaurantId) {
    return (
      <section className="flex flex-col gap-3">
        <PageHeading title={t('queue.empty_title')} count={null} />
        <p className="text-s-muted text-sm">{t('queue.pick_restaurant')}</p>
      </section>
    );
  }
  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <PageHeading title={t('queue.empty_title')} count={null} />
        <p className="text-s-muted text-sm">{t('queue.loading')}</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="flex flex-col gap-3">
        <PageHeading title={t('queue.empty_title')} count={null} />
        <p className="text-sm text-danger">{(error as Error).message}</p>
      </section>
    );
  }
  if (!data || data.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <PageHeading title={t('queue.empty_title')} count={0} />
        <div className="empty rounded-lg border border-s-line bg-s-paper mt-2">
          <div className="art">
            <ListChecks size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">{t('queue.empty_title')}</p>
          <p className="text-[13px] text-s-muted mt-1.5 max-w-[40ch]">{t('queue.empty')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <PageHeading title={t('queue.empty_title')} count={data.length} />

      <div className="rounded-lg border border-s-line bg-s-paper overflow-hidden">
        {/* column heads */}
        <div
          className="grid items-center gap-3.5 px-4 py-2 border-b border-s-line bg-s-bg/50 text-[11px] font-semibold text-s-muted dev uppercase tracking-wide"
          style={{ gridTemplateColumns: '56px 92px 1fr 150px 96px 112px' }}
        >
          <span />
          <span>{t('queue.col_photos')}</span>
          <span>{t('queue.col_table')}</span>
          <span>{t('queue.col_signals')}</span>
          <span className="text-right">{t('queue.col_score')}</span>
          <span className="text-right">{t('queue.col_action')}</span>
        </div>

        <ul>
          {data.map((row) => (
            <li key={row.session_id}>
              <Link
                to={`/validations/${row.session_id}`}
                className="vrow group"
                aria-label={t('queue.review_button')}
              >
                {/* col 1 — status dot */}
                <StatusDot
                  suspicious={row.suspicious}
                  lowConfidence={
                    row.model_confidence !== null && row.model_confidence < 0.75
                  }
                />
                {/* col 2 — thumb pair */}
                <div className="flex gap-1.5">
                  <img
                    src={row.before_image_url}
                    alt="before"
                    className="w-10 h-10 object-cover rounded border border-s-line"
                  />
                  <img
                    src={row.after_image_url}
                    alt="after"
                    className="w-10 h-10 object-cover rounded border border-s-line"
                  />
                </div>
                {/* col 3 — table + items */}
                <div className="min-w-0">
                  <div className="row gap-2 items-center">
                    <span className="font-semibold text-s-ink text-[14px]">
                      {t('queue.table', { code: row.table_code })}
                    </span>
                    <span className="row gap-1 items-center text-s-muted text-[12px]">
                      <Clock size={11} />
                      {ageLabel(row.score_age_seconds)}
                    </span>
                  </div>
                  <p className="text-[13px] text-s-muted truncate mt-0.5">
                    {row.ordered_items
                      .map((i) => `${i.quantity}× ${i.name}`)
                      .join(', ')}
                  </p>
                </div>
                {/* col 4 — signal chips */}
                <div className="flex flex-wrap gap-1">
                  {row.suspicious && (
                    <span className="chip chip-danger">
                      <ShieldAlert size={11} />
                      {t('queue.possible_tampering')}
                    </span>
                  )}
                  {row.model_confidence !== null && row.model_confidence < 0.75 && (
                    <span className="chip chip-amber">
                      <HelpCircle size={11} />
                      {t('queue.low_confidence')}
                    </span>
                  )}
                  {row.fraud_signals.length > 0 && (
                    <span className="chip chip-amber">
                      <AlertTriangle size={11} />
                      {t('queue.fraud_signals_count', {
                        count: row.fraud_signals.length,
                      })}
                    </span>
                  )}
                </div>
                {/* col 5 — score */}
                <div className="text-right">
                  <div className="tnum font-bold text-[18px] text-s-ink">
                    {Math.round(row.score * 100)}
                    <span className="text-[12px] text-s-muted font-semibold ml-0.5">%</span>
                  </div>
                </div>
                {/* col 6 — review CTA */}
                <div className="text-right">
                  <span className="inline-flex items-center gap-1 chip chip-brand group-hover:bg-brand group-hover:text-white transition">
                    {t('queue.review_button')}
                    <ChevronRight size={12} />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PageHeading({ title, count }: { title: string; count: number | null }) {
  const { t } = useTranslation();
  return (
    <header className="row gap-3 items-center">
      <div>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.nav.validations')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">{title}</h1>
      </div>
      {count !== null && (
        <span className="chip chip-brand ml-auto">
          {t('queue.count_pending', { count })}
        </span>
      )}
    </header>
  );
}

function StatusDot({
  suspicious,
  lowConfidence,
}: {
  suspicious: boolean;
  lowConfidence: boolean;
}) {
  const tone = suspicious
    ? 'bg-danger'
    : lowConfidence
      ? 'bg-amber'
      : 'bg-sage';
  return (
    <div className="row items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${tone}`} />
    </div>
  );
}
