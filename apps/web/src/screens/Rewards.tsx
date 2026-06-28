import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, HeartHandshake, Clock, Check } from 'lucide-react';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { formatValue } from '../components/ChooseRewardType';
import { LangToggle } from '../components/LangToggle';

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

/**
 * Rewards inbox — every reward this diner ever earned, sorted by
 * usefulness: full-value first, then half-value (still spendable),
 * then historical (redeemed / voided / expired).
 *
 * Each row is a perforated `.ticket` card — the design system's stub
 * holds the redemption code so the diner can flash it without
 * digging through text.
 */
export function Rewards() {
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);
  const { data, isLoading } = useQuery({
    queryKey: ['rewards'],
    queryFn: () => api.get<Reward[]>('/rewards', token),
  });

  return (
    <div className="d-screen flex flex-col min-h-full">
      <div className="px-5 pt-4 pb-2">
        <div className="spread">
          <span />
          <LangToggle />
        </div>
        <h1 className="display text-[26px] mt-3.5">{t('rewards.title')}</h1>
      </div>

      <div className="px-4 pb-6 flex-1 flex flex-col gap-3">
        {isLoading && (
          <p className="text-muted text-sm text-center py-8">
            {t('rewards.loading')}
          </p>
        )}

        {!isLoading && (!data || data.length === 0) && (
          <div className="empty">
            <div className="art">
              <Sparkles size={32} />
            </div>
            <p className="text-sm">{t('rewards.empty')}</p>
          </div>
        )}

        {!isLoading && data && data.length > 0 && (
          <RewardList rewards={data} t={t} />
        )}
      </div>
    </div>
  );
}

function RewardList({
  rewards,
  t,
}: {
  rewards: Reward[];
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const now = new Date();
  const derived = rewards.map((r) => classify(r, now));
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
    <ul className="flex flex-col gap-3">
      {derived.map((r) => (
        <RewardTicket key={r.id} reward={r} t={t} />
      ))}
    </ul>
  );
}

interface TicketProps {
  reward: DerivedReward;
  t: ReturnType<typeof useTranslation>['t'];
}

function RewardTicket({ reward: r, t }: TicketProps) {
  const typeLabel =
    r.reward_type === 'menu_item'
      ? t('choose_reward.type.menu_item_label')
      : t('choose_reward.type.bill_discount_label');
  const value = r.current_value_minor ?? r.value_minor;
  const dim = r.phase === 'expired' || r.phase === 'voided';
  const ticketClass = dim ? 'ticket dim' : r.phase === 'full' ? 'ticket full' : 'ticket';

  return (
    <li className={ticketClass}>
      <div className="body flex flex-col gap-1.5">
        <div className="row gap-1.5 items-center">
          <HeartHandshake size={14} className="text-saffron-deep" />
          <span className="font-semibold text-[12.5px] text-saffron-deep">
            {typeLabel}
          </span>
        </div>
        <div className="tnum font-bold text-[22px] leading-none">
          {formatValue(value)}
          {r.phase === 'half' && (
            <span className="text-amber-deep text-xs ml-1.5 font-semibold">
              {t('rewards.half_value_suffix')}
            </span>
          )}
        </div>
        <WindowLine reward={r} t={t} />
        <div className="text-xs text-muted mt-0.5">
          {t('rewards.issued_expires', {
            issued: new Date(r.issued_at).toLocaleDateString(),
            expires: new Date(r.expires_at).toLocaleDateString(),
          })}
        </div>
      </div>
      <div className="stub">
        <div className="code text-[20px]">{r.redemption_code}</div>
        <StatusBadge phase={r.phase} t={t} />
      </div>
    </li>
  );
}

function StatusBadge({ phase, t }: { phase: Phase; t: TicketProps['t'] }) {
  switch (phase) {
    case 'full':
      return <span className="chip chip-saffron">{t('rewards.full_value')}</span>;
    case 'half':
      return <span className="chip chip-amber">{t('rewards.half_value')}</span>;
    case 'redeemed':
      return <span className="chip chip-muted"><Check size={12} />{t('rewards.redeemed_badge')}</span>;
    case 'voided':
      return <span className="chip chip-danger">{t('rewards.voided')}</span>;
    case 'expired':
      return <span className="chip chip-muted">{t('rewards.expired')}</span>;
  }
}

function WindowLine({ reward: r, t }: TicketProps) {
  if (r.phase === 'redeemed' && r.redeemed_at) {
    return (
      <div className="text-xs text-muted">
        {r.redeemed_value_minor != null
          ? t('rewards.redeemed_for', {
              datetime: new Date(r.redeemed_at).toLocaleString(),
              amount: formatValue(r.redeemed_value_minor),
            })
          : t('rewards.redeemed_no_amount', {
              datetime: new Date(r.redeemed_at).toLocaleString(),
            })}
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
        <div className="row gap-1.5 items-center text-xs text-muted">
          <Clock size={12} />
          <span>
            {t('rewards.full_window_until', {
              date: new Date(r.half_value_at).toLocaleDateString(),
            })}{' '}
            · {daysText}
          </span>
        </div>
      );
    }
    return (
      <div className="row gap-1.5 items-center text-xs text-amber-deep">
        <Clock size={12} />
        <span>{daysText}</span>
      </div>
    );
  }
  return null;
}
