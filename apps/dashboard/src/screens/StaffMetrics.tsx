import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Users, AlertTriangle, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface Snapshot {
  period_start: string;
  period_end: string;
  validations_count: number;
  approvals_count: number;
  rejections_count: number;
  adjustments_count: number;
  rejection_rate: number;
  approval_rate: number;
  override_rate: number;
  restaurant_median_rejection_rate: number;
  over_threshold: boolean;
}

interface StaffRow {
  staff_user_id: string;
  email: string;
  display_name: string | null;
  snapshots: Snapshot[];
}

/**
 * StaffMetrics — per-staff rejection / override rates over the last
 * four weeks. Rows over the alert threshold are flagged red so an
 * owner can spot someone who needs coaching.
 */
export function StaffMetrics() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ['staff-metrics', restaurantId],
    queryFn: () =>
      api.get<StaffRow[]>(
        `/restaurants/${restaurantId}/dashboard/staff-metrics?weeks=4`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 60_000,
  });

  if (!restaurantId)
    return <p className="text-s-muted text-sm">{t('staff_metrics.pick_restaurant')}</p>;

  return (
    <section className="flex flex-col gap-4">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.nav.staff_metrics')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('staff_metrics.title')}
        </h1>
        <p className="text-[13px] text-s-muted max-w-3xl mt-1.5">
          {t('staff_metrics.blurb')}
        </p>
      </header>

      {isLoading ? (
        <p className="text-s-muted text-sm">{t('staff_metrics.loading')}</p>
      ) : !data || data.length === 0 ? (
        <div className="empty rounded-lg border border-s-line bg-s-paper">
          <div className="art">
            <Users size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {t('staff_metrics.empty')}
          </p>
        </div>
      ) : (
        data.map((row) => (
          <article
            key={row.staff_user_id}
            className="rounded-lg bg-s-paper border border-s-line overflow-hidden"
          >
            <header className="row gap-3 items-center px-4 py-3 border-b border-s-line bg-s-bg/50">
              <div className="w-8 h-8 rounded-full bg-brand-wash text-brand flex items-center justify-center text-[11px] font-bold dev">
                {(row.display_name ?? row.email).slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-[14px] text-s-ink truncate">
                  {row.display_name ?? row.email}
                </div>
                {row.display_name && (
                  <div className="text-[11.5px] text-s-muted truncate">{row.email}</div>
                )}
              </div>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] min-w-[720px]">
                <thead>
                  <tr className="text-[11px] text-s-muted dev uppercase tracking-wide bg-s-bg/30">
                    <th className="text-left px-4 py-2 font-semibold">
                      {t('staff_metrics.column.period')}
                    </th>
                    <th className="text-right px-2 py-2 font-semibold">
                      {t('staff_metrics.column.validations')}
                    </th>
                    <th className="text-right px-2 py-2 font-semibold">
                      {t('staff_metrics.column.approved')}
                    </th>
                    <th className="text-right px-2 py-2 font-semibold">
                      {t('staff_metrics.column.rejected')}
                    </th>
                    <th className="text-right px-2 py-2 font-semibold">
                      {t('staff_metrics.column.adjusted')}
                    </th>
                    <th className="text-right px-2 py-2 font-semibold">
                      {t('staff_metrics.column.rejection_rate')}
                    </th>
                    <th className="text-right px-2 py-2 font-semibold">
                      {t('staff_metrics.column.override_rate')}
                    </th>
                    <th className="text-right px-2 py-2 font-semibold">
                      {t('staff_metrics.column.median')}
                    </th>
                    <th className="text-center px-3 py-2 font-semibold">
                      {t('staff_metrics.column.alert')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {row.snapshots.map((s) => (
                    <tr
                      key={s.period_start}
                      className={clsx(
                        'border-t border-s-line',
                        s.over_threshold && 'bg-danger-wash/50',
                      )}
                    >
                      <td className="px-4 py-2 text-s-ink">
                        {new Date(s.period_start).toLocaleDateString()}
                      </td>
                      <td className="text-right px-2 py-2 tnum">
                        {s.validations_count}
                      </td>
                      <td className="text-right px-2 py-2 tnum text-sage">
                        {s.approvals_count}
                      </td>
                      <td className="text-right px-2 py-2 tnum text-danger">
                        {s.rejections_count}
                      </td>
                      <td className="text-right px-2 py-2 tnum text-amber-deep">
                        {s.adjustments_count}
                      </td>
                      <td className="text-right px-2 py-2 tnum">
                        {(s.rejection_rate * 100).toFixed(0)}%
                      </td>
                      <td className="text-right px-2 py-2 tnum">
                        {(s.override_rate * 100).toFixed(0)}%
                      </td>
                      <td className="text-right px-2 py-2 tnum text-s-muted">
                        {(s.restaurant_median_rejection_rate * 100).toFixed(0)}%
                      </td>
                      <td className="text-center px-3 py-2">
                        {s.over_threshold ? (
                          <span className="chip chip-danger">
                            <AlertTriangle size={11} />
                            {t('staff_metrics.over_threshold_badge')}
                          </span>
                        ) : (
                          <span className="chip chip-sage">
                            <Check size={11} />
                            {t('staff_metrics.ok_badge')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
