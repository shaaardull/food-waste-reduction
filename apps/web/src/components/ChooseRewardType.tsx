import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Utensils, Receipt } from 'lucide-react';
import type { Reward, RewardType } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface Props {
  reward: Reward;
  onChosen: () => void;
}

function formatValue(minor: number): string {
  return `₹${(minor / 100).toFixed(0)}`;
}

/**
 * Diner picks which form their reward takes — a free dish, or a
 * discount on next bill. Same money value either way; we just need
 * a non-default choice for the kitchen.
 */
export function ChooseRewardType({ reward, onChosen }: Props) {
  const { t } = useTranslation();
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
    <section className="card p-5 flex flex-col gap-4">
      <div className="row gap-3 items-center">
        <div className="w-12 h-12 rounded-md bg-saffron-wash text-saffron-deep flex items-center justify-center">
          <Sparkles size={22} />
        </div>
        <div className="flex-1">
          <h2 className="display text-[22px] leading-tight">
            {t('choose_reward.heading')}
          </h2>
          <p className="text-sm text-muted mt-1 leading-snug">
            <Trans
              i18nKey="choose_reward.value_blurb"
              values={{ amount: formatValue(value) }}
              components={{ strong: <strong className="tnum text-ink" /> }}
            />
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {allowed.includes('menu_item') && (
          <RewardChoiceButton
            icon={<Utensils size={20} />}
            label={t('choose_reward.type.menu_item_label')}
            blurb={t('choose_reward.type.menu_item_blurb')}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('menu_item')}
          />
        )}
        {allowed.includes('bill_discount') && (
          <RewardChoiceButton
            icon={<Receipt size={20} />}
            label={t('choose_reward.type.bill_discount_label')}
            blurb={t('choose_reward.type.bill_discount_blurb')}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('bill_discount')}
          />
        )}
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}
    </section>
  );
}

interface ChoiceProps {
  icon: React.ReactNode;
  label: string;
  blurb: string;
  disabled: boolean;
  onClick: () => void;
}

function RewardChoiceButton({ icon, label, blurb, disabled, onClick }: ChoiceProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-left card-flat p-3.5 row gap-3 items-start hover:border-brand transition disabled:opacity-50"
    >
      <div className="w-10 h-10 rounded-md bg-brand-wash text-brand flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[15px]">{label}</div>
        <div className="dev text-sm text-muted mt-0.5 leading-snug">{blurb}</div>
      </div>
    </button>
  );
}

export { formatValue };
