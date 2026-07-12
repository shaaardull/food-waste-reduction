import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuthStore } from './auth';

/**
 * Small hook that powers the "Sessions" top-nav pill.
 *
 * Shares the `['my-sessions']` query key with the MySessions screen so
 * both surfaces stay cache-consistent — a resume tap that mutates the
 * session status invalidates one place, badge updates for free.
 *
 * "Live" here means every status where the diner still has an action
 * to take. Once the flow lands in a terminal state (rewarded, expired,
 * cancelled, disputed, staff_rejected, staff_approved) the row drops
 * out of the count so the badge stays quiet after the meal is done.
 */

interface SessionSummary {
  id: string;
  status: string;
}

const LIVE_STATUSES = new Set([
  'open',
  'before_captured',
  'eating',
  'after_submitted',
  'scored',
  'pending_staff_validation',
]);

export function useLiveSessionsCount(): number {
  const token = useAuthStore((s) => s.token);
  const { data } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get<SessionSummary[]>('/sessions', token),
    enabled: Boolean(token),
    // Poll every 30 s and on window focus — a diner tabbing back after
    // a staff decision should see the pill drop off within a beat.
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  if (!data) return 0;
  return data.filter((s) => LIVE_STATUSES.has(s.status)).length;
}
