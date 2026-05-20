import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface SummaryData {
  range: string;
  sessions: number;
  rewarded: number;
  rejected: number;
  pending_validation: number;
  avg_final_score: number | null;
}

export function Summary() {
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data } = useQuery({
    queryKey: ['summary', restaurantId],
    queryFn: () =>
      api.get<SummaryData>(`/restaurants/${restaurantId}/dashboard/summary?range=7d`, token),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 30_000,
  });

  if (!restaurantId)
    return <p className="text-slate-600">Sign in and pick a restaurant first.</p>;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Last 7 days</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Sessions" value={data?.sessions ?? '…'} />
        <Stat label="Rewarded" value={data?.rewarded ?? '…'} />
        <Stat label="Rejected" value={data?.rejected ?? '…'} />
        <Stat label="Avg score" value={data?.avg_final_score ? `${Math.round(data.avg_final_score * 100)}%` : '—'} />
      </div>
      {data && data.pending_validation > 0 && (
        <Link
          to="/validations"
          className="block rounded-lg bg-brand-50 border border-brand-600 text-brand-700 p-3 hover:bg-brand-50/80"
        >
          {data.pending_validation} session(s) need your review &rarr;
        </Link>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg bg-white border border-slate-200 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}
