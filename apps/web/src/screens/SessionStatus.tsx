import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { ChooseRewardType, formatValue } from '../components/ChooseRewardType';

interface SessionDetail {
  session: { id: string; status: string };
  items: Array<{ menu_item_id: string; quantity: number }>;
  captures: Array<{ phase: string; captured_at: string }>;
  score?: { overall_score: number; suspicious: boolean } | null;
  reward?: Reward | null;
}

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

  if (isLoading || !data) return <p className="text-slate-600">{t('session_status.loading')}</p>;

  const status = data.session.status;
  const hasBefore = data.captures.some((c) => c.phase === 'before');

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">{t('session_status.title')}</h1>
      <p className="text-sm text-slate-600">
        {t('session_status.status_label')}: <span className="font-medium">{prettyStatus(status)}</span>
      </p>

      {status === 'open' && (
        <Link
          to={`/sessions/${id}/before`}
          className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
        >
          {t('session_status.take_before')}
        </Link>
      )}

      {status === 'before_captured' && (
        <div className="space-y-3">
          <p className="text-slate-600">{t('session_status.between_meals_hint')}</p>
          <Link
            to={`/sessions/${id}/after`}
            className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
          >
            {t('session_status.claim_after')}
          </Link>
        </div>
      )}

      {(status === 'after_submitted' || status === 'pending_staff_validation') && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2">
          <p className="font-medium">{t('session_status.review_heading')}</p>
          <p className="text-sm text-slate-600">{t('session_status.review_blurb')}</p>
        </div>
      )}

      {status === 'staff_approved' && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2">
          <p className="font-medium">{t('session_status.approved_heading')}</p>
          <p className="text-sm text-slate-600">{t('session_status.approved_blurb')}</p>
        </div>
      )}

      {status === 'rewarded' && data.reward && (
        <RewardPanel reward={data.reward} typeChosen={typeChosen} onChosen={() => setTypeChosen(true)} />
      )}

      {status === 'staff_rejected' && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2">
          <p className="font-medium">{t('session_status.rejected_heading')}</p>
          <p className="text-sm text-slate-600">{t('session_status.rejected_blurb')}</p>
        </div>
      )}

      {hasBefore && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">{t('session_status.session_details')}</summary>
          <pre className="mt-2 overflow-auto">{JSON.stringify(data, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

interface RewardPanelProps {
  reward: Reward;
  typeChosen: boolean;
  onChosen: () => void;
}

function RewardPanel({ reward, typeChosen, onChosen }: RewardPanelProps) {
  const { t } = useTranslation();
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
    <div className="rounded-lg border-2 border-brand-600 bg-brand-50 p-4 space-y-2">
      <p className="text-sm text-slate-600">{t('reward_panel.show_to_server')}</p>
      <p className="text-3xl font-bold text-brand-700 tracking-wide">{reward.redemption_code}</p>
      <p className="text-sm text-slate-600">
        {t('reward_panel.type_label')}: <span className="font-medium">{typeLabel}</span>
      </p>
      <p className="text-sm">
        {t('reward_panel.current_value_label')}:{' '}
        <span className="font-medium">{formatValue(value)}</span>
        {inHalfWindow && (
          <span className="ml-2 text-amber-700 text-xs">
            {t('reward_panel.half_value_until', { date: expires.toLocaleDateString() })}
          </span>
        )}
        {!inHalfWindow && now < halfAt && (
          <span className="ml-2 text-xs text-slate-500">
            {t('reward_panel.full_until', { date: halfAt.toLocaleDateString() })}
          </span>
        )}
      </p>
      {reward.redeemed_at && (
        <p className="text-xs text-slate-500">
          {t('reward_panel.redeemed_at', { datetime: new Date(reward.redeemed_at).toLocaleString() })}
        </p>
      )}
    </div>
  );
}

function prettyStatus(s: string): string {
  return s.replace(/_/g, ' ');
}
