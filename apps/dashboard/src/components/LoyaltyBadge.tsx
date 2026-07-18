import type { TFunction } from 'i18next';

/**
 * LoyaltyBadge — bare numeric repeat-visit tier (1..10) shown in the
 * corner of Live Orders cards and the order-detail drawer header.
 *
 * Product decision: only the digit is visible. No label, no tooltip,
 * no "what's this?" popover. Staff who care learn what it means;
 * those who don't ignore it. Screen readers get the announcement via
 * aria-label (translated in en/hi/mr).
 *
 * Renders nothing when `score` is null / out of range, so walk-in and
 * takeaway cards (no diner_user_id) simply have no badge.
 */
export function LoyaltyBadge({
  score,
  t,
}: {
  score: number | null;
  t: TFunction;
}) {
  if (typeof score !== 'number' || score < 1 || score > 10) return null;
  return (
    <span
      role="img"
      aria-label={t('live_orders.loyalty_aria', { n: score })}
      className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-full bg-brand/10 text-brand text-[11px] font-bold font-mono tabular-nums"
    >
      {score}
    </span>
  );
}
