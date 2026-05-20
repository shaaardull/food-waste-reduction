import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Reward, RewardType } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface Props {
  reward: Reward;
  onChosen: () => void;
}

const TYPE_LABEL: Record<RewardType, string> = {
  menu_item: 'A free dish',
  bill_discount: 'Discount off your next bill',
};

const TYPE_BLURB: Record<RewardType, string> = {
  menu_item: 'Hand the code to your server. The kitchen sends out the dish.',
  bill_discount:
    'Same value, applied as a discount the next time you eat at this restaurant. Good for 30 days.',
};

function formatValue(minor: number): string {
  return `₹${(minor / 100).toFixed(0)}`;
}

export function ChooseRewardType({ reward, onChosen }: Props) {
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (reward_type: RewardType) =>
      api.post<Reward>(
        `/rewards/${encodeURIComponent(reward.redemption_code)}/choose-type`,
        { reward_type },
        token,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session'] });
      queryClient.invalidateQueries({ queryKey: ['rewards'] });
      onChosen();
    },
    onError: (err: ApiException) => setError(err.message),
  });

  const allowed = reward.allowed_reward_types ?? ['menu_item', 'bill_discount'];
  const value = reward.current_value_minor ?? reward.value_minor;

  return (
    <section className="rounded-lg border-2 border-brand-600 bg-brand-50 p-4 space-y-3">
      <header className="space-y-1">
        <p className="font-medium text-brand-700">Pick how you'd like your reward.</p>
        <p className="text-sm text-slate-600">
          Value: <span className="font-medium">{formatValue(value)}</span>. Same either way.
          You have 30 days &mdash; full value for the first 15, half value after.
        </p>
      </header>
      <div className="grid gap-2">
        {allowed.includes('menu_item') && (
          <button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('menu_item')}
            className="text-left rounded-lg bg-white border border-slate-200 p-3 hover:border-brand-600 disabled:opacity-50"
          >
            <div className="font-medium">{TYPE_LABEL.menu_item}</div>
            <div className="text-xs text-slate-500">{TYPE_BLURB.menu_item}</div>
          </button>
        )}
        {allowed.includes('bill_discount') && (
          <button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('bill_discount')}
            className="text-left rounded-lg bg-white border border-slate-200 p-3 hover:border-brand-600 disabled:opacity-50"
          >
            <div className="font-medium">{TYPE_LABEL.bill_discount}</div>
            <div className="text-xs text-slate-500">{TYPE_BLURB.bill_discount}</div>
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

export { TYPE_LABEL, TYPE_BLURB, formatValue };
