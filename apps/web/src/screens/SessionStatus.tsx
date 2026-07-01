import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  Utensils,
  Hourglass,
  Sparkles,
  HeartHandshake,
  AlertCircle,
  QrCode,
  Clock,
  Check,
} from 'lucide-react';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { ChooseRewardType, formatValue } from '../components/ChooseRewardType';
import { LangToggle } from '../components/LangToggle';

interface SessionDetail {
  session: { id: string; status: string; table_code?: string };
  items: Array<{ menu_item_id: string; quantity: number }>;
  captures: Array<{ phase: string; captured_at: string }>;
  score?: { overall_score: number; suspicious: boolean } | null;
  reward?: Reward | null;
}

/**
 * SessionStatus — diner's view of where their meal is in the flow.
 *
 * Six visually distinct states the screen reflects:
 *   open                          → take the BEFORE photo
 *   before_captured               → eat, then claim with AFTER photo
 *   after_submitted / pending     → server reviewing
 *   staff_approved (no reward)    → approved but under threshold
 *   rewarded                      → big reward ticket with redemption code
 *   staff_rejected                → no reward + dispute path
 *
 * Polls every 2-3s while in transient states (CLAUDE.md §3 — async
 * staff validation). Stops polling on terminal states.
 */
export function SessionStatus() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const token = useAuthStore((s) => s.token);
  const [typeChosen, setTypeChosen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.get<SessionDetail>(`/sessions/${id}`, token),
    refetchInterval: (q) => {
      const status = (q.state.data as SessionDetail | undefined)?.session.status;
      if (!status) return 2_000;
      if (['rewarded', 'staff_approved', 'staff_rejected', 'disputed'].includes(status)) return false;
      return 3_000;
    },
  });

  if (isLoading || !data) {
    return (
      <div className="d-screen min-h-full px-5 py-12">
        <p className="text-muted text-sm text-center">{t('session_status.loading')}</p>
      </div>
    );
  }

  const status = data.session.status;
  const tableCode = data.session.table_code;

  return (
    <div className="d-screen flex flex-col min-h-full">
      {/* header */}
      <div className="px-5 pt-4 pb-2">
        <div className="spread">
          {tableCode ? (
            <span className="chip chip-brand">
              <QrCode size={14} />
              {t('order.table_fallback')} · {tableCode}
            </span>
          ) : (
            <span />
          )}
          <LangToggle />
        </div>
        <h1 className="display text-[26px] mt-3.5">{t('session_status.title')}</h1>
      </div>

      <div className="px-4 pb-6 flex-1 flex flex-col gap-4">
        {status === 'open' && data.items.length > 0 && (
          // Order placed — food is on the way. The before-photo CTA is
          // voluntary so the diner isn't yanked into the camera before
          // the plates land.
          <StateCard
            tone="brand"
            icon={<Utensils size={22} />}
            heading={t('session_status.waiting_for_food_heading')}
            blurb={t('session_status.waiting_for_food_blurb')}
            ctaHref={`/sessions/${id}/before`}
            ctaLabel={t('session_status.take_before')}
          />
        )}

        {status === 'open' && data.items.length === 0 && (
          <StateCard
            tone="brand"
            icon={<Camera size={22} />}
            heading={t('session_status.take_before')}
            blurb={t('session_status.between_meals_hint')}
            ctaHref={`/sessions/${id}/before`}
            ctaLabel={t('session_status.take_before')}
          />
        )}

        {status === 'before_captured' && (
          <StateCard
            tone="sage"
            icon={<Utensils size={22} />}
            heading={t('session_status.between_meals_hint')}
            ctaHref={`/sessions/${id}/after`}
            ctaLabel={t('session_status.claim_after')}
          />
        )}

        {(status === 'after_submitted' || status === 'pending_staff_validation') && (
          <ReviewWaitingCard t={t} />
        )}

        {status === 'staff_approved' && (
          <OutcomeCard
            tone="sage"
            icon={<Check size={22} />}
            heading={t('session_status.approved_heading')}
            blurb={t('session_status.approved_blurb')}
          />
        )}

        {status === 'rewarded' && data.reward && (
          <RewardPanel
            reward={data.reward}
            typeChosen={typeChosen}
            onChosen={() => setTypeChosen(true)}
            t={t}
          />
        )}

        {status === 'staff_rejected' && (
          <OutcomeCard
            tone="muted"
            icon={<AlertCircle size={22} />}
            heading={t('session_status.rejected_heading')}
            blurb={t('session_status.rejected_blurb')}
          />
        )}

        {/* dev affordance — collapsed by default */}
        <details className="text-xs text-muted mt-auto">
          <summary className="cursor-pointer dev">{t('session_status.session_details')}</summary>
          <pre className="dev mt-2 overflow-auto bg-paper border border-line rounded-md p-2">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

/* ----- pieces ----------------------------------------------------- */

interface StateCardProps {
  tone: 'brand' | 'sage';
  icon: React.ReactNode;
  heading: string;
  blurb?: string;
  ctaHref: string;
  ctaLabel: string;
}

function StateCard({ tone, icon, heading, blurb, ctaHref, ctaLabel }: StateCardProps) {
  const accent =
    tone === 'sage' ? 'bg-sage-wash text-sage' : 'bg-brand-wash text-brand';
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className={`w-12 h-12 rounded-md flex items-center justify-center ${accent}`}>
        {icon}
      </div>
      <div>
        <h2 className="display text-[22px] leading-tight">{heading}</h2>
        {blurb && (
          <p className="text-sm text-muted mt-1.5 leading-snug">{blurb}</p>
        )}
      </div>
      <Link
        to={ctaHref}
        className="btn btn-primary btn-block min-h-[52px]"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}

function ReviewWaitingCard({ t }: { t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="row gap-3 items-center">
        <div className="w-12 h-12 rounded-md bg-amber-wash text-amber-deep flex items-center justify-center">
          <Hourglass size={22} className="animate-pulse" />
        </div>
        <div className="row gap-1.5 items-center text-amber-deep">
          <Clock size={14} />
          <span className="font-semibold text-[12.5px]">&lt; 1 min</span>
        </div>
      </div>
      <div>
        <h2 className="display text-[22px] leading-tight">
          {t('session_status.review_heading')}
        </h2>
        <p className="text-sm text-muted mt-1.5 leading-snug">
          {t('session_status.review_blurb')}
        </p>
      </div>
    </div>
  );
}

interface OutcomeCardProps {
  tone: 'sage' | 'muted' | 'danger';
  icon: React.ReactNode;
  heading: string;
  blurb: string;
}

function OutcomeCard({ tone, icon, heading, blurb }: OutcomeCardProps) {
  const accent =
    tone === 'sage'
      ? 'bg-sage-wash text-sage'
      : tone === 'danger'
        ? 'bg-danger-wash text-danger'
        : 'bg-paper text-muted';
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className={`w-12 h-12 rounded-md flex items-center justify-center ${accent}`}>
        {icon}
      </div>
      <div>
        <h2 className="display text-[22px] leading-tight">{heading}</h2>
        <p className="text-sm text-muted mt-1.5 leading-snug">{blurb}</p>
      </div>
    </div>
  );
}

interface RewardPanelProps {
  reward: Reward;
  typeChosen: boolean;
  onChosen: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function RewardPanel({ reward, typeChosen, onChosen, t }: RewardPanelProps) {
  const allowed = reward.allowed_reward_types ?? ['menu_item', 'bill_discount'];
  const hasChoice = allowed.length > 1;
  const showCode = !hasChoice || typeChosen || Boolean(reward.redeemed_at);

  if (!showCode) {
    return <ChooseRewardType reward={reward} onChosen={onChosen} />;
  }

  const value = reward.current_value_minor ?? reward.value_minor;
  const expires = new Date(reward.expires_at);
  const halfAt = new Date(reward.half_value_at);
  const now = new Date();
  const inHalfWindow = now >= halfAt && now < expires;
  const typeLabel =
    reward.reward_type === 'menu_item'
      ? t('choose_reward.type.menu_item_label')
      : t('choose_reward.type.bill_discount_label');

  return (
    <div className="flex flex-col gap-3">
      {/* hero confirmation banner */}
      <div className="confbanner rounded-md bg-saffron-wash text-saffron-deep">
        <Sparkles size={18} />
        <span>{t('session_status.approved_heading')}</span>
      </div>

      {/* the ticket */}
      <div className="ticket full">
        <div className="body flex flex-col gap-2">
          <div className="row gap-1.5 items-center">
            <HeartHandshake size={14} className="text-saffron-deep" />
            <span className="font-semibold text-[12.5px] text-saffron-deep">
              {typeLabel}
            </span>
          </div>
          <div className="tnum font-bold text-[28px] leading-none">
            {formatValue(value)}
          </div>
          <div className="text-xs text-muted">
            {t('reward_panel.show_to_server')}
          </div>
          <div className="text-xs mt-1">
            {inHalfWindow ? (
              <span className="text-amber-deep">
                {t('reward_panel.half_value_until', {
                  date: expires.toLocaleDateString(),
                })}
              </span>
            ) : now < halfAt ? (
              <span className="text-muted">
                {t('reward_panel.full_until', {
                  date: halfAt.toLocaleDateString(),
                })}
              </span>
            ) : null}
          </div>
          {reward.redeemed_at && (
            <div className="text-xs text-muted">
              {t('reward_panel.redeemed_at', {
                datetime: new Date(reward.redeemed_at).toLocaleString(),
              })}
            </div>
          )}
        </div>
        <div className="stub">
          <div className="code text-[22px]">{reward.redemption_code}</div>
          <div className="chip chip-saffron">
            {inHalfWindow
              ? t('rewards.half_value')
              : t('rewards.full_value')}
          </div>
        </div>
      </div>
    </div>
  );
}
