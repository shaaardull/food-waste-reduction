import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
    return <p className="text-slate-600">{t('staff_metrics.pick_restaurant')}</p>;
  if (isLoading) return <p className="text-slate-600">{t('staff_metrics.loading')}</p>;
  if (!data || data.length === 0)
    return (
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">{t('staff_metrics.title')}</h1>
        <p className="text-slate-600">{t('staff_metrics.empty')}</p>
      </section>
    );

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t('staff_metrics.title')}</h1>
        <p className="text-sm text-slate-600 max-w-3xl">{t('staff_metrics.blurb')}</p>
      </header>

      {data.map((row) => (
        <article
          key={row.staff_user_id}
          className="rounded-lg bg-white border border-slate-200 overflow-hidden"
        >
          <header className="px-4 py-2 border-b border-slate-100 bg-slate-50">
            <p className="text-sm font-medium">
              {row.display_name
                ? t('staff_metrics.staff_label', {
                    name: row.display_name,
                    email: row.email,
                  })
                : t('staff_metrics.no_display_name', { email: row.email })}
            </p>
          </header>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">{t('staff_metrics.column.period')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('staff_metrics.column.validations')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('staff_metrics.column.approved')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('staff_metrics.column.rejected')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('staff_metrics.column.adjusted')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('staff_metrics.column.rejection_rate')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('staff_metrics.column.override_rate')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('staff_metrics.column.median')}</th>
                <th className="text-center px-2 py-2 font-medium">{t('staff_metrics.column.alert')}</th>
              </tr>
            </thead>
            <tbody>
              {row.snapshots.map((s) => (
                <tr
                  key={s.period_start}
                  className={
                    s.over_threshold ? 'bg-red-50 border-t border-red-100' : 'border-t border-slate-100'
                  }
                >
                  <td className="px-4 py-2">{new Date(s.period_start).toLocaleDateString()}</td>
                  <td className="text-right px-2 py-2">{s.validations_count}</td>
                  <td className="text-right px-2 py-2">{s.approvals_count}</td>
                  <td className="text-right px-2 py-2">{s.rejections_count}</td>
                  <td className="text-right px-2 py-2">{s.adjustments_count}</td>
                  <td className="text-right px-2 py-2">{(s.rejection_rate * 100).toFixed(0)}%</td>
                  <td className="text-right px-2 py-2">{(s.override_rate * 100).toFixed(0)}%</td>
                  <td className="text-right px-2 py-2 text-slate-500">
                    {(s.restaurant_median_rejection_rate * 100).toFixed(0)}%
                  </td>
                  <td className="text-center px-2 py-2">
                    {s.over_threshold ? (
                      <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
                        {t('staff_metrics.over_threshold_badge')}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">{t('staff_metrics.ok_badge')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      ))}
    </section>
  );
}
