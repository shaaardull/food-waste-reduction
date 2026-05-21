import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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

  if (!restaurantId) return <p className="text-slate-600">{t('queue.pick_restaurant')}</p>;
  if (isLoading) return <p className="text-slate-600">{t('queue.loading')}</p>;
  if (error) return <p className="text-red-700">{(error as Error).message}</p>;
  if (!data || data.length === 0)
    return (
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">{t('queue.empty_title')}</h1>
        <p className="text-slate-600">{t('queue.empty')}</p>
      </section>
    );

  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">{t('queue.title', { count: data.length })}</h1>
      <ul className="space-y-3">
        {data.map((row) => (
          <li
            key={row.session_id}
            className="rounded-lg bg-white border border-slate-200 p-3 flex items-center gap-4"
          >
            <div className="flex gap-2 w-44 shrink-0">
              <img src={row.before_image_url} alt="before" className="w-20 h-20 object-cover rounded" />
              <img src={row.after_image_url} alt="after" className="w-20 h-20 object-cover rounded" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{t('queue.table', { code: row.table_code })}</span>
                <span className="text-sm text-slate-500">{ageLabel(row.score_age_seconds)}</span>
                <span className="text-sm bg-slate-100 px-2 py-0.5 rounded">
                  {t('queue.score', { percent: Math.round(row.score * 100) })}
                </span>
                {row.suspicious && (
                  <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
                    {t('queue.possible_tampering')}
                  </span>
                )}
                {row.model_confidence !== null && row.model_confidence < 0.75 && (
                  <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                    {t('queue.low_confidence')}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-600 truncate">
                {row.ordered_items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
              </p>
              {row.fraud_signals.length > 0 && (
                <p className="text-xs text-amber-700 mt-1">
                  {t('queue.fraud_signals_count', { count: row.fraud_signals.length })}
                </p>
              )}
            </div>
            <Link
              to={`/validations/${row.session_id}`}
              className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-2 text-sm"
            >
              {t('queue.review_button')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
