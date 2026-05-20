import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface RewardRow {
  id: string;
  redemption_code: string;
  issued_at: string;
  expires_at: string;
  redeemed_at: string | null;
}

export function Rewards() {
  const token = useAuthStore((s) => s.token);
  const { data, isLoading } = useQuery({
    queryKey: ['rewards'],
    queryFn: () => api.get<RewardRow[]>('/rewards', token),
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
        {data.map((r) => (
          <li key={r.id} className="rounded-lg border border-slate-200 p-3">
            <div className="font-mono text-lg">{r.redemption_code}</div>
            <div className="text-xs text-slate-500">
              Issued {new Date(r.issued_at).toLocaleString()} · expires {new Date(r.expires_at).toLocaleString()}
            </div>
            <div className="text-xs mt-1">
              {r.redeemed_at ? (
                <span className="text-slate-500">Redeemed {new Date(r.redeemed_at).toLocaleString()}</span>
              ) : (
                <span className="text-brand-700">Available</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
