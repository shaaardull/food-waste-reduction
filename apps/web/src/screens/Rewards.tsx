import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { formatValue } from '../components/ChooseRewardType';

export function Rewards() {
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);
  const { data, isLoading } = useQuery({
    queryKey: ['rewards'],
    queryFn: () => api.get<Reward[]>('/rewards', token),
  });

  if (isLoading) return <p className="text-slate-600">{t('rewards.loading')}</p>;
  if (!data || data.length === 0)
    return (
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">{t('rewards.title')}</h1>
        <p className="text-slate-600">{t('rewards.empty')}</p>
      </section>
    );

  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">{t('rewards.title')}</h1>
      <ul className="space-y-2">
        {data.map((r) => {
          const now = new Date();
          const halfAt = new Date(r.half_value_at);
          const expires = new Date(r.expires_at);
          const expired = now >= expires || Boolean(r.voided_at);
          const inHalf = !expired && now >= halfAt;
          const current = r.current_value_minor ?? r.value_minor;
          const typeLabel =
            r.reward_type === 'menu_item'
              ? t('choose_reward.type.menu_item_label')
              : t('choose_reward.type.bill_discount_label');
          return (
            <li key={r.id} className="rounded-lg border border-slate-200 p-3">
              <div className="font-mono text-lg">{r.redemption_code}</div>
              <div className="text-xs text-slate-500">
                {typeLabel} &middot; {formatValue(current)}
                {inHalf && ` ${t('rewards.half_value_suffix')}`}
              </div>
              <div className="text-xs text-slate-500">
                {t('rewards.issued_expires', {
                  issued: new Date(r.issued_at).toLocaleDateString(),
                  expires: expires.toLocaleDateString(),
                })}
              </div>
              <div className="text-xs mt-1">
                {r.redeemed_at ? (
                  <span className="text-slate-500">
                    {r.redeemed_value_minor != null
                      ? t('rewards.redeemed_for', {
                          datetime: new Date(r.redeemed_at).toLocaleString(),
                          amount: formatValue(r.redeemed_value_minor),
                        })
                      : t('rewards.redeemed_no_amount', {
                          datetime: new Date(r.redeemed_at).toLocaleString(),
                        })}
                  </span>
                ) : r.voided_at ? (
                  <span className="text-red-700">{t('rewards.voided')}</span>
                ) : expired ? (
                  <span className="text-slate-500">{t('rewards.expired')}</span>
                ) : (
                  <span className="text-brand-700">{t('rewards.available')}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
