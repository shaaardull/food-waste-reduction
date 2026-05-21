import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface DisputeRow {
  id: string;
  meal_session_id: string;
  reason: string;
  status: string;
  created_at: string;
}

export function Disputes() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ['disputes', restaurantId, filter],
    queryFn: () => {
      // The list endpoint takes ?status=open. For "all" we fetch each
      // status individually and concatenate; saves adding a new server
      // shape for this small case.
      if (filter === 'open') {
        return api.get<DisputeRow[]>(
          `/restaurants/${restaurantId}/dashboard/disputes?status=open`,
          token,
        );
      }
      return Promise.all([
        api.get<DisputeRow[]>(
          `/restaurants/${restaurantId}/dashboard/disputes?status=open`,
          token,
        ),
        api.get<DisputeRow[]>(
          `/restaurants/${restaurantId}/dashboard/disputes?status=resolved_in_favor_diner`,
          token,
        ),
        api.get<DisputeRow[]>(
          `/restaurants/${restaurantId}/dashboard/disputes?status=resolved_in_favor_restaurant`,
          token,
        ),
        api.get<DisputeRow[]>(
          `/restaurants/${restaurantId}/dashboard/disputes?status=closed`,
          token,
        ),
      ]).then((batches) =>
        batches
          .flat()
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      );
    },
    enabled: Boolean(restaurantId && token),
    refetchInterval: 15_000,
  });

  if (isLoading) return <p className="text-slate-600">{t('disputes.loading')}</p>;
  const rows = data ?? [];

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold">{t('disputes.list_title')}</h1>
        <div className="flex gap-2 text-sm">
          {(['open', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 border ${
                filter === f
                  ? 'bg-brand-700 text-white border-brand-700'
                  : 'border-slate-300 text-slate-700'
              }`}
            >
              {f === 'open' ? t('disputes.status_filter_open') : t('disputes.status_filter_all')}
            </button>
          ))}
        </div>
      </header>
      <p className="text-sm text-slate-600 max-w-3xl">{t('disputes.blurb')}</p>
      {rows.length === 0 ? (
        <p className="text-slate-600 text-sm">
          {filter === 'open' ? t('disputes.empty_open') : t('disputes.empty_all')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-lg bg-white border border-slate-200 p-3 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {t('disputes.row.raised_at', {
                    datetime: new Date(row.created_at).toLocaleString(),
                  })}
                </div>
                <div className="text-xs text-slate-500 truncate">{row.reason}</div>
                <div className="text-xs text-slate-400 mt-1">
                  {t(`disputes.status.${row.status}`, { defaultValue: row.status })}
                </div>
              </div>
              <Link
                to={`/disputes/${row.id}`}
                className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-2 text-sm"
              >
                {t('disputes.review_button')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
