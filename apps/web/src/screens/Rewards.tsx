import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { formatValue } from '../components/ChooseRewardType';

type Phase = 'full' | 'half' | 'expired' | 'voided' | 'redeemed';

interface DerivedReward extends Reward {
  phase: Phase;
  daysLeft: number; // 0 if expired / voided / redeemed
}

function classify(r: Reward, now: Date): DerivedReward {
  const expires = new Date(r.expires_at);
  const halfAt = new Date(r.half_value_at);
  let phase: Phase;
  let daysLeft = 0;
  if (r.redeemed_at) {
    phase = 'redeemed';
  } else if (r.voided_at) {
    phase = 'voided';
  } else if (now >= expires) {
    phase = 'expired';
  } else if (now >= halfAt) {
    phase = 'half';
    daysLeft = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / 86_400_000));
  } else {
    phase = 'full';
    daysLeft = Math.max(0, Math.ceil((halfAt.getTime() - now.getTime()) / 86_400_000));
  }
  return { ...r, phase, daysLeft };
}

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

  const now = new Date();
  const derived = data.map((r) => classify(r, now));
  // Sort: full > half > redeemed > voided > expired, then newest issued first.
  const phaseRank: Record<Phase, number> = {
    full: 0,
    half: 1,
    redeemed: 2,
    voided: 3,
    expired: 4,
  };
  derived.sort((a, b) => {
    if (phaseRank[a.phase] !== phaseRank[b.phase])
      return phaseRank[a.phase] - phaseRank[b.phase];
    return new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime();
  });

  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">{t('rewards.title')}</h1>
      <ul className="space-y-2">
        {derived.map((r) => (
          <RewardCard key={r.id} reward={r} t={t} />
        ))}
      </ul>
    </section>
  );
}

interface CardProps {
  reward: DerivedReward;
  t: ReturnType<typeof useTranslation>['t'];
}

function RewardCard({ reward: r, t }: CardProps) {
  const typeLabel =
    r.reward_type === 'menu_item'
      ? t('choose_reward.type.menu_item_label')
      : t('choose_reward.type.bill_discount_label');
  const value = r.current_value_minor ?? r.value_minor;
  const dim = r.phase === 'expired' || r.phase === 'voided';

  return (
    <li
      className={`rounded-lg border p-3 ${
        dim ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-slate-200'
      } ${r.phase === 'full' ? 'border-brand-600/40' : ''}`}
    >
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-lg">{r.redemption_code}</div>
        <StatusBadge phase={r.phase} t={t} />
      </div>
      <div className="text-xs text-slate-500 mt-0.5">
        {typeLabel} &middot; {formatValue(value)}
        {r.phase === 'half' && ` ${t('rewards.half_value_suffix')}`}
      </div>
      <WindowLine reward={r} t={t} />
      <div className="text-xs text-slate-400 mt-1">
        {t('rewards.issued_expires', {
          issued: new Date(r.issued_at).toLocaleDateString(),
          expires: new Date(r.expires_at).toLocaleDateString(),
        })}
      </div>
    </li>
  );
}

function StatusBadge({ phase, t }: { phase: Phase; t: CardProps['t'] }) {
  switch (phase) {
    case 'full':
      return (
        <span className="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full">
          {t('rewards.full_value')}
        </span>
      );
    case 'half':
      return (
        <span className="text-xs bg-amber-50 text-amber-800 px-2 py-0.5 rounded-full">
          {t('rewards.half_value')}
        </span>
      );
    case 'redeemed':
      return (
        <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
          ✓
        </span>
      );
    case 'voided':
      return (
        <span className="text-xs bg-red-50 text-red-700 px-2 py-0.5 rounded-full">
          {t('rewards.voided')}
        </span>
      );
    case 'expired':
      return (
        <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
          {t('rewards.expired')}
        </span>
      );
  }
}

function WindowLine({ reward: r, t }: CardProps) {
  if (r.phase === 'redeemed' && r.redeemed_at) {
    return (
      <div className="text-xs text-slate-500 mt-1">
        {r.redeemed_value_minor != null
          ? t('rewards.redeemed_for', {
              datetime: new Date(r.redeemed_at).toLocaleString(),
              amount: formatValue(r.redeemed_value_minor),
            })
          : t('rewards.redeemed_no_amount', { datetime: new Date(r.redeemed_at).toLocaleString() })}
      </div>
    );
  }
  if (r.phase === 'full' || r.phase === 'half') {
    const daysText =
      r.daysLeft === 0
        ? t('rewards.expires_today')
        : r.daysLeft === 1
          ? t('rewards.days_left', { count: 1 })
          : t('rewards.days_left_plural', { count: r.daysLeft });
    if (r.phase === 'full') {
      return (
        <div className="text-xs text-slate-600 mt-1">
          {t('rewards.full_window_until', {
            date: new Date(r.half_value_at).toLocaleDateString(),
          })}{' '}
          &middot; {daysText}
        </div>
      );
    }
    return <div className="text-xs text-amber-700 mt-1">{daysText}</div>;
  }
  return null;
}
