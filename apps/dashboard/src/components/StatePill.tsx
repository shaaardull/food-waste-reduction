import { clsx } from 'clsx';

/**
 * State pill for the Live Orders + drawer views. Colour is by *meaning*,
 * not channel (spec §6.5):
 *   amber = needs staff action (served, pending-validation)
 *   sage  = money-safe        (paid, rewarded)
 *   brand = in-progress       (serving, before_captured, after_submitted)
 *   muted = neutral           (open with nothing to do yet)
 */

// Session-status → semantic bucket. Keep the map narrow: anything
// unknown falls to the muted bucket rather than crashing.
type Tone = 'amber' | 'sage' | 'brand' | 'muted';

const STATE_TONE: Record<string, Tone> = {
  open: 'muted',
  serving: 'brand',
  served: 'amber',
  billed: 'sage',
  paid: 'sage',
  voided: 'muted',
  before_captured: 'brand',
  after_submitted: 'brand',
  pending_staff_validation: 'amber',
  staff_approved: 'sage',
  staff_rejected: 'muted',
  rewarded: 'sage',
  cancelled: 'muted',
  expired: 'muted',
  disputed: 'amber',
  eating: 'brand',
};

const TONE_CLASSES: Record<Tone, string> = {
  amber: 'bg-amber-wash text-amber-deep',
  sage: 'bg-sage-wash text-sage',
  brand: 'bg-brand-wash text-brand',
  muted: 'bg-s-line text-s-muted',
};

export function StatePill({
  state,
  label,
  className,
}: {
  state: string;
  label: string;
  className?: string;
}) {
  const tone = STATE_TONE[state] ?? 'muted';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
