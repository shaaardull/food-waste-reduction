import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquareWarning, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface DisputeRow {
  id: string;
  meal_session_id: string;
  reason: string;
  status: string;
  created_at: string;
}

/**
 * Disputes — owner queue for diner-raised complaints. Open by default;
 * "all" tab fans out four parallel fetches and concatenates so the
 * owner can see resolved history without adding a new server shape.
 */
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
        batches.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      );
    },
    enabled: Boolean(restaurantId && token),
    refetchInterval: 15_000,
  });

  const rows = data ?? [];

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="row spread items-end flex-wrap gap-2">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('app.nav.disputes')}
            </div>
            <h1 className="display text-[28px] text-s-ink leading-tight">
              {t('disputes.list_title')}
            </h1>
          </div>
          <div className="row gap-1.5">
            {(['open', 'all'] as const).map((f) => {
              const active = filter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={clsx(
                    'chip transition',
                    active
                      ? 'bg-brand text-white'
                      : 'bg-s-paper border border-s-line text-s-muted hover:text-s-ink',
                  )}
                  aria-pressed={active}
                >
                  {f === 'open'
                    ? t('disputes.status_filter_open')
                    : t('disputes.status_filter_all')}
                </button>
              );
            })}
          </div>
        </div>
        <p className="text-[13px] text-s-muted max-w-3xl">{t('disputes.blurb')}</p>
      </header>

      {isLoading ? (
        <p className="text-s-muted text-sm">{t('disputes.loading')}</p>
      ) : rows.length === 0 ? (
        <div className="empty rounded-lg border border-s-line bg-s-paper">
          <div className="art">
            <MessageSquareWarning size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {filter === 'open'
              ? t('disputes.empty_open')
              : t('disputes.empty_all')}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to={`/disputes/${row.id}`}
                className="bg-s-paper border border-s-line rounded-lg p-3.5 row gap-3 items-center hover:border-brand transition group"
              >
                <div className="w-10 h-10 rounded-md bg-amber-wash text-amber-deep flex items-center justify-center flex-shrink-0">
                  <MessageSquareWarning size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="row gap-2 items-center">
                    <span className="font-semibold text-[14px] text-s-ink">
                      {t('disputes.row.raised_at', {
                        datetime: new Date(row.created_at).toLocaleString(),
                      })}
                    </span>
                    <span
                      className={clsx(
                        'chip',
                        row.status === 'open' ? 'chip-amber' : 'chip-muted',
                      )}
                    >
                      {t(`disputes.status.${row.status}`, {
                        defaultValue: row.status,
                      })}
                    </span>
                  </div>
                  <p className="text-[13px] text-s-muted truncate mt-0.5">
                    {row.reason}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 chip chip-brand group-hover:bg-brand group-hover:text-white transition">
                  {t('disputes.review_button')}
                  <ChevronRight size={12} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
