import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { ChooseRewardType, TYPE_LABEL, formatValue } from '../components/ChooseRewardType';

interface SessionDetail {
  session: { id: string; status: string };
  items: Array<{ menu_item_id: string; quantity: number }>;
  captures: Array<{ phase: string; captured_at: string }>;
  score?: { overall_score: number; suspicious: boolean } | null;
  reward?: Reward | null;
}

export function SessionStatus() {
  const { id = '' } = useParams();
  const token = useAuthStore((s) => s.token);

  // Once the diner has explicitly chosen a type (or had no choice), reveal the code.
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

  if (isLoading || !data) return <p className="text-slate-600">Loading…</p>;

  const status = data.session.status;
  const hasBefore = data.captures.some((c) => c.phase === 'before');

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">Your meal</h1>
      <p className="text-sm text-slate-600">
        Status: <span className="font-medium">{prettyStatus(status)}</span>
      </p>

      {status === 'open' && (
        <Link
          to={`/sessions/${id}/before`}
          className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
        >
          Take the before photo
        </Link>
      )}

      {status === 'before_captured' && (
        <div className="space-y-3">
          <p className="text-slate-600">Enjoy your meal. When you're ready to pay, come back here.</p>
          <Link
            to={`/sessions/${id}/after`}
            className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
          >
            Claim &mdash; take the after photo
          </Link>
        </div>
      )}

      {(status === 'after_submitted' || status === 'pending_staff_validation') && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2">
          <p className="font-medium">Your server is reviewing &mdash; usually under a minute.</p>
          <p className="text-sm text-slate-600">
            A staff member checks the photo against your table before any reward is issued. We'll update this
            screen the moment they decide.
          </p>
        </div>
      )}

      {status === 'staff_approved' && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2">
          <p className="font-medium">Approved &mdash; thanks for finishing what you ordered.</p>
          <p className="text-sm text-slate-600">
            Your score was just below the threshold this time, so no reward today. Try a smaller portion next
            visit to land it.
          </p>
        </div>
      )}

      {status === 'rewarded' && data.reward && (
        <RewardPanel reward={data.reward} typeChosen={typeChosen} onChosen={() => setTypeChosen(true)} />
      )}

      {status === 'staff_rejected' && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2">
          <p className="font-medium">No reward this time.</p>
          <p className="text-sm text-slate-600">
            The server didn't see enough food finished to qualify. If you think this is wrong, you can raise
            a dispute &mdash; an owner will look at it within 48 hours.
          </p>
        </div>
      )}

      {hasBefore && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">Session details</summary>
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
  const allowed = reward.allowed_reward_types ?? ['menu_item', 'bill_discount'];
  const hasChoice = allowed.length > 1;
  // If only one type is allowed, or the diner has already picked, jump straight to the code.
  const showCode = !hasChoice || typeChosen || Boolean(reward.redeemed_at);

  if (!showCode) {
    return <ChooseRewardType reward={reward} onChosen={onChosen} />;
  }

  const value = reward.current_value_minor ?? reward.value_minor;
  const expires = new Date(reward.expires_at);
  const halfAt = new Date(reward.half_value_at);
  const now = new Date();
  const inHalfWindow = now >= halfAt && now < expires;

  return (
    <div className="rounded-lg border-2 border-brand-600 bg-brand-50 p-4 space-y-2">
      <p className="text-sm text-slate-600">Show this to your server:</p>
      <p className="text-3xl font-bold text-brand-700 tracking-wide">{reward.redemption_code}</p>
      <p className="text-sm text-slate-600">
        Type: <span className="font-medium">{TYPE_LABEL[reward.reward_type]}</span>
      </p>
      <p className="text-sm">
        Current value: <span className="font-medium">{formatValue(value)}</span>
        {inHalfWindow && (
          <span className="ml-2 text-amber-700 text-xs">
            (half value &mdash; expires {expires.toLocaleDateString()})
          </span>
        )}
        {!inHalfWindow && now < halfAt && (
          <span className="ml-2 text-xs text-slate-500">
            full value until {halfAt.toLocaleDateString()}
          </span>
        )}
      </p>
      {reward.redeemed_at && (
        <p className="text-xs text-slate-500">Redeemed {new Date(reward.redeemed_at).toLocaleString()}</p>
      )}
    </div>
  );
}

function prettyStatus(s: string): string {
  return s.replace(/_/g, ' ');
}
