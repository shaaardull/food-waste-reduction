import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, HeartHandshake, Clock, Check, MapPin, ChevronDown, History } from 'lucide-react';
import { clsx } from 'clsx';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useNewRewardsBadge } from '../lib/newRewards';
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
  // Clears the "+N" top-nav badge — mount is the right moment because
  // the diner is now looking at the inbox. Guarded so a diner with a
  // stale-tab reload doesn't keep re-writing localStorage.
  const { markSeen } = useNewRewardsBadge();
  useEffect(() => {
    markSeen();
  }, [markSeen]);
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

  // Three buckets:
  //   active   — full / half; can still be shown to staff.
  //   redeemed — already used at least once. Kept visible so the diner
  //              has a receipt of what they spent (previous behaviour
  //              hid these under a collapsed toggle, which meant a
  //              diner asking "did I already use PLATE-4E43?" had to
  //              dig).
  //   archived — expired / voided; no diner action possible, so kept
  //              collapsed to avoid drowning fresh coupons.
  const isActive = (p: Phase) => p === 'full' || p === 'half';
  const active = derived
    .filter((r) => isActive(r.phase))
    .sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === 'full' ? -1 : 1;
      return new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime();
    });
  const redeemed = derived
    .filter((r) => r.phase === 'redeemed')
    .sort(
      (a, b) =>
        new Date(b.redeemed_at ?? b.issued_at).getTime() -
        new Date(a.redeemed_at ?? a.issued_at).getTime(),
    );
  const archived = derived
    .filter((r) => r.phase === 'expired' || r.phase === 'voided')
    .sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === 'voided' ? -1 : 1;
      return new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime();
    });

  const [archivedOpen, setArchivedOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      {active.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="row gap-1.5 items-center text-[11.5px] font-bold tracking-wide dev text-brand uppercase">
            <Sparkles size={12} />
            {t('rewards.section_active', { count: active.length })}
          </div>
          <ul className="flex flex-col gap-3">
            {active.map((r) => (
              <RewardTicket key={r.id} reward={r} t={t} />
            ))}
          </ul>
        </section>
      )}

      {active.length === 0 && (redeemed.length > 0 || archived.length > 0) && (
        // Empty active state message when the diner has ONLY history —
        // don't just show them a wall of expired chips, tell them
        // what happened.
        <div className="card p-4 flex flex-col items-center text-center gap-1.5">
          <Sparkles size={22} className="text-muted" />
          <p className="text-[13.5px] text-ink font-semibold">
            {t('rewards.no_active_title')}
          </p>
          <p className="text-[12px] text-muted leading-snug max-w-[36ch]">
            {t('rewards.no_active_blurb')}
          </p>
        </div>
      )}

      {redeemed.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="row gap-1.5 items-center text-[11.5px] font-bold tracking-wide dev text-muted uppercase">
            <Check size={12} />
            {t('rewards.section_redeemed', { count: redeemed.length })}
          </div>
          <ul className="flex flex-col gap-3">
            {redeemed.map((r) => (
              <RewardTicket key={r.id} reward={r} t={t} />
            ))}
          </ul>
        </section>
      )}

      {archived.length > 0 && (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setArchivedOpen((v) => !v)}
            className="row spread items-center bg-paper border border-line rounded-md px-3 py-2.5 hover:border-brand transition"
          >
            <div className="row gap-2 items-center">
              <History size={14} className="text-muted" />
              <span className="font-semibold text-[13px] text-ink">
                {t('rewards.section_archived', { count: archived.length })}
              </span>
            </div>
            <ChevronDown
              size={14}
              className={clsx(
                'transition-transform text-muted',
                archivedOpen && 'rotate-180',
              )}
            />
          </button>
          {archivedOpen && (
            <ul className="flex flex-col gap-3">
              {archived.map((r) => (
                <RewardTicket key={r.id} reward={r} t={t} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
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
        {/* Diner may hold coupons from more than one restaurant —
            show the issuing venue on every card so it's unambiguous
            which one this coupon works at. */}
        {r.restaurant_name && (
          <div className="row gap-1 items-center text-[12px] text-brand">
            <MapPin size={12} />
            <span className="truncate">{r.restaurant_name}</span>
          </div>
        )}
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
