import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Reward } from '@plate-clean/shared-types';
import { api } from './api';
import { useAuthStore } from './auth';

/**
 * Tracks how many "unseen" rewards the diner has since they last opened
 * the Rewards inbox. Powers the small "+N" badge on the top-nav Rewards
 * link — including the compensation reward minted when an owner
 * resolves a dispute in the diner's favour.
 *
 * "Unseen" is stored as a per-user timestamp in localStorage. Rewards
 * with `issued_at > lastSeen` count as new; expired / voided / already
 * redeemed rewards never count (nothing actionable there).
 */

const STORAGE_PREFIX = 'plate-clean:last-seen-rewards:';

function storageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `${STORAGE_PREFIX}${userId}`;
}

function readLastSeen(userId: string | null | undefined): number {
  const key = storageKey(userId);
  if (!key || typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeLastSeen(userId: string | null | undefined, ts: number): void {
  const key = storageKey(userId);
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(ts));
  } catch {
    // Safari private mode can throw; a lost badge is not worth crashing.
  }
}

export function useNewRewardsBadge(): {
  count: number;
  markSeen: () => void;
} {
  const token = useAuthStore((s) => s.token);
  const userId = useAuthStore((s) => s.user?.id);

  // Poll every 60s and on window focus (TanStack Query default) so a
  // dispute resolved while the diner is on another tab surfaces the
  // moment they come back.
  const { data } = useQuery({
    queryKey: ['rewards', 'badge', userId],
    queryFn: () => api.get<Reward[]>('/rewards', token),
    enabled: Boolean(token && userId),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  // Read the "last seen" timestamp from storage. We hold it in state
  // so `markSeen()` triggers a re-render and immediately clears the
  // badge without waiting for a refetch.
  const [lastSeen, setLastSeen] = useState<number>(() => readLastSeen(userId));
  useEffect(() => {
    setLastSeen(readLastSeen(userId));
  }, [userId]);

  const markSeen = useCallback(() => {
    const now = Date.now();
    writeLastSeen(userId, now);
    setLastSeen(now);
  }, [userId]);

  if (!data) return { count: 0, markSeen };

  const now = Date.now();
  const count = data.filter((r) => {
    if (r.redeemed_at || r.voided_at) return false;
    if (new Date(r.expires_at).getTime() <= now) return false;
    return new Date(r.issued_at).getTime() > lastSeen;
  }).length;

  return { count, markSeen };
}
