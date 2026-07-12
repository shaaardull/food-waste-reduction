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
  Receipt,
} from 'lucide-react';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useOptimisticStore } from '../lib/optimistic';
import { ChooseRewardType, formatValue } from '../components/ChooseRewardType';
import { GetBillModal } from '../components/GetBillModal';
import { LangToggle } from '../components/LangToggle';
import { RaiseDisputeModal } from '../components/RaiseDisputeModal';

interface SessionDetail {
  session: {
    id: string;
    status: string;
    table_code?: string;
    cancelled_reason?: string | null;
    cancelled_at?: string | null;
  };
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
  const [billModalOpen, setBillModalOpen] = useState(false);
  const [disputeModalOpen, setDisputeModalOpen] = useState(false);

  // Optimistic upload flag for the before-photo (see lib/optimistic.ts
  // and Capture.tsx). When `pending` we render "Claim after" even if
  // the server still reports `open`; when `error` we render a retry
  // banner instead.
  const optimisticBefore = useOptimisticStore((s) => s.beforeUploads[id]);

  const { data, isLoading } = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.get<SessionDetail>(`/sessions/${id}`, token),
    refetchInterval: (q) => {
      const status = (q.state.data as SessionDetail | undefined)?.session.status;
      if (!status) return 2_000;
      // Cancelled joins the terminal set — no polling once the staff
      // pulls the plug on the order.
      if (
        ['rewarded', 'staff_approved', 'staff_rejected', 'disputed', 'cancelled'].includes(
          status,
        )
      )
        return false;
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

  // `effectiveStatus` blends server truth with the optimistic
  // before-upload flag. If the diner just tapped Submit and the
  // upload is in flight (or the poll got in before it landed),
  // we still render "Claim after". Once the flag clears — success
  // or error — the raw server status wins on the next render.
  const rawStatus = data.session.status;
  const status =
    optimisticBefore?.kind === 'pending' && rawStatus === 'open'
      ? 'before_captured'
      : rawStatus;
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
        {/* Optimistic upload failure — the before-photo submit didn't
            land on the server. We surface a red banner with a
            "try again" CTA that sends the diner back to the camera.
            The banner is scoped to the case where the raw server
            status is still `open` (i.e. the retry actually makes
            sense — otherwise the flag is stale from a prior meal). */}
        {optimisticBefore?.kind === 'error' && rawStatus === 'open' && (
          <div className="card p-4 flex flex-col gap-2.5 bg-danger-wash/40 border-danger/25">
            <div className="row gap-2 items-center">
              <AlertCircle size={16} className="text-danger" />
              <div className="font-bold text-[14px] text-ink">
                {t('session_status.before_upload_failed_heading')}
              </div>
            </div>
            <p className="text-[12.5px] text-muted leading-snug">
              {optimisticBefore.message}
            </p>
            <Link
              to={`/sessions/${id}/before`}
              className="btn btn-outline min-h-[42px] text-[13.5px]"
            >
              {t('session_status.before_upload_retry')}
            </Link>
          </div>
        )}

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

        {/* Raise-a-dispute CTA — visible on rejected sessions per
            ethics rule 9 (diner recourse) and on staff_approved with
            no reward (score just below threshold, diner may feel the
            call was harsh). Once the dispute is filed the session
            flips to 'disputed' and we swap the CTA for a
            confirmation strip. */}
        {(status === 'staff_rejected' || status === 'staff_approved') && (
          <button
            onClick={() => setDisputeModalOpen(true)}
            className="card p-4 row gap-3 items-center hover:border-danger transition text-left"
          >
            <div className="w-10 h-10 rounded-md bg-danger-wash text-danger flex items-center justify-center flex-shrink-0">
              <AlertCircle size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-[15px] text-ink">
                {t('session_status.raise_dispute_title')}
              </div>
              <div className="text-[12.5px] text-muted mt-0.5">
                {t('session_status.raise_dispute_blurb')}
              </div>
            </div>
            <div className="text-danger font-bold text-[16px]">→</div>
          </button>
        )}

        {status === 'disputed' && (
          <div className="card p-4 row gap-3 items-center bg-danger-wash/40 border-danger/20">
            <div className="w-10 h-10 rounded-md bg-danger-wash text-danger flex items-center justify-center flex-shrink-0">
              <AlertCircle size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-[15px] text-ink">
                {t('session_status.disputed_heading')}
              </div>
              <div className="text-[12.5px] text-muted mt-0.5">
                {t('session_status.disputed_blurb')}
              </div>
            </div>
          </div>
        )}

        {/* Ethics rule 9 — diner recourse. If the staff cancelled the
            order, surface the reason the staff typed in, not a generic
            "cancelled" copy. Reason is required server-side. */}
        {status === 'cancelled' && (
          <OutcomeCard
            tone="muted"
            icon={<AlertCircle size={22} />}
            heading={t('session_status.cancelled_heading')}
            blurb={
              data.session.cancelled_reason ??
              t('session_status.cancelled_blurb_fallback')
            }
          />
        )}

        {/* Bill CTA — available whenever the diner has ordered
            something and is in a state where a bill makes sense.
            Idempotent on the API side, so a diner tapping this twice
            just re-sends. */}
        {(status === 'rewarded' ||
          status === 'staff_approved' ||
          status === 'staff_rejected' ||
          status === 'before_captured' ||
          status === 'after_submitted' ||
          status === 'pending_staff_validation' ||
          status === 'disputed') &&
          data.items.length > 0 && (
            <button
              onClick={() => setBillModalOpen(true)}
              className="card p-4 row gap-3 items-center hover:border-brand transition text-left"
            >
              <div className="w-10 h-10 rounded-md bg-brand-wash text-brand flex items-center justify-center flex-shrink-0">
                <Receipt size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-[15px] text-ink">
                  {t('session_status.get_bill_title')}
                </div>
                <div className="text-[12.5px] text-muted mt-0.5">
                  {t('session_status.get_bill_blurb')}
                </div>
              </div>
              <div className="text-brand font-bold text-[16px]">→</div>
            </button>
          )}

        {/* dev affordance — collapsed by default */}
        <details className="text-xs text-muted mt-auto">
          <summary className="cursor-pointer dev">{t('session_status.session_details')}</summary>
          <pre className="dev mt-2 overflow-auto bg-paper border border-line rounded-md p-2">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>

      {billModalOpen && (
        <GetBillModal
          sessionId={id}
          onClose={() => setBillModalOpen(false)}
        />
      )}
      {disputeModalOpen && (
        <RaiseDisputeModal
          sessionId={id}
          onClose={() => setDisputeModalOpen(false)}
        />
      )}
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
    <div className="flex flex-col gap-4">
      {/* v2 sprout celebration hero — a growing plant on a radial
          sage→brand disc, sparse confetti dots that boop in, and the
          "you grew a little forest" italic headline. Replaces the
          v1 saffron confbanner as the emotional peak of the flow. */}
      <SproutCelebration t={t} />
      {/* legacy confirmation ribbon — kept as a compact status line
          under the hero so the ticket below still has context. */}
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
          {/* Restaurant-of-issue chip — a diner may hold coupons from
              multiple restaurants, so we surface the name front and
              centre. The backend enforces this too (staff at a
              different restaurant can't redeem), but the diner
              shouldn't have to learn that at the counter. */}
          {reward.restaurant_name && (
            <div className="row gap-1.5 items-center mt-1">
              <QrCode size={13} className="text-brand" />
              <span className="text-[12.5px] text-ink">
                {t('reward_panel.redeemable_at', {
                  name: reward.restaurant_name,
                })}
              </span>
            </div>
          )}
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

/**
 * SproutCelebration — the reward-issued emotional peak.
 *
 * A sprout grows on a radial sage→brand disc, sparse confetti
 * squares boop in around it, and the "you grew a little forest"
 * italic headline lands underneath. Sits at the top of RewardPanel
 * (the `rewarded` state); the redemption-code ticket follows below.
 */
function SproutCelebration({
  t,
}: {
  t: ReturnType<typeof useTranslation>['t'];
}) {
  // A handful of confetti dots sprinkled around the sprout. Each one
  // has its own colour + delay so the boop cascades rather than fires
  // in unison. Positions are relative to the disc's centre.
  interface ConfoDot {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
    color: string;
    delay: string;
  }
  const confetti: ConfoDot[] = [
    { top: '4%', left: '18%', color: 'hsl(33 88% 56%)', delay: '0.1s' },
    { top: '10%', right: '20%', color: 'hsl(78 64% 50%)', delay: '0.18s' },
    { top: '40%', left: '6%', color: 'hsl(340 62% 58%)', delay: '0.24s' },
    { top: '52%', right: '4%', color: 'hsl(145 54% 40%)', delay: '0.3s' },
    { bottom: '18%', left: '22%', color: 'hsl(28 78% 44%)', delay: '0.36s' },
    { bottom: '10%', right: '26%', color: 'hsl(153 46% 33%)', delay: '0.42s' },
  ];

  return (
    <section className="card p-5 flex flex-col items-center text-center gap-3 relative overflow-hidden">
      {/* confetti field */}
      {confetti.map((c, i) => (
        <span
          key={i}
          className="confo"
          style={{
            top: c.top,
            bottom: c.bottom,
            left: c.left,
            right: c.right,
            background: c.color,
            animationDelay: c.delay,
          }}
        />
      ))}

      {/* sprout */}
      <div className="sprout" aria-hidden>
        <div className="soil" />
        <div className="stem grow-up" style={{ animationDelay: '0.15s' }} />
        <div
          className="leaf l grow-up"
          style={{ animationDelay: '0.55s', transformOrigin: 'bottom right' }}
        />
        <div
          className="leaf r grow-up"
          style={{ animationDelay: '0.7s', transformOrigin: 'bottom left' }}
        />
      </div>

      {/* italic headline + subcopy */}
      <div>
        <h2 className="display text-[28px] text-brand leading-[1.02] px-2">
          {t('session_status.grew_forest_heading')}
        </h2>
        <p className="text-[13.5px] text-muted mt-2 leading-snug max-w-[36ch] mx-auto">
          {t('session_status.grew_forest_sub')}
        </p>
      </div>
    </section>
  );
}
