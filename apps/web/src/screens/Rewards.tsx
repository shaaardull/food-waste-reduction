import { useQuery } from '@tanstack/react-query';
import type { Reward } from '@plate-clean/shared-types';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { TYPE_LABEL, formatValue } from '../components/ChooseRewardType';

export function Rewards() {
  const token = useAuthStore((s) => s.token);
  const { data, isLoading } = useQuery({
    queryKey: ['rewards'],
    queryFn: () => api.get<Reward[]>('/rewards', token),
  });

  if (isLoading) return <p className="text-slate-600">Loading…</p>;
  if (!data || data.length === 0)
    return (
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">Your rewards</h1>
        <p className="text-slate-600">Nothing here yet. Finish your next meal and one will show up.</p>
      </section>
    );

  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">Your rewards</h1>
      <ul className="space-y-2">
        {data.map((r) => {
          const now = new Date();
          const halfAt = new Date(r.half_value_at);
          const expires = new Date(r.expires_at);
          const expired = now >= expires || Boolean(r.voided_at);
          const inHalf = !expired && now >= halfAt;
          const current = r.current_value_minor ?? r.value_minor;
          return (
            <li key={r.id} className="rounded-lg border border-slate-200 p-3">
              <div className="font-mono text-lg">{r.redemption_code}</div>
              <div className="text-xs text-slate-500">
                {TYPE_LABEL[r.reward_type]} &middot; {formatValue(current)}
                {inHalf && ' (half value)'}
              </div>
              <div className="text-xs text-slate-500">
                Issued {new Date(r.issued_at).toLocaleDateString()} &middot; expires{' '}
                {expires.toLocaleDateString()}
              </div>
              <div className="text-xs mt-1">
                {r.redeemed_at ? (
                  <span className="text-slate-500">
                    Redeemed {new Date(r.redeemed_at).toLocaleString()}
                    {r.redeemed_value_minor != null && ` for ${formatValue(r.redeemed_value_minor)}`}
                  </span>
                ) : r.voided_at ? (
                  <span className="text-red-700">Voided</span>
                ) : expired ? (
                  <span className="text-slate-500">Expired</span>
                ) : (
                  <span className="text-brand-700">Available</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
