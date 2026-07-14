import { clsx } from 'clsx';

/**
 * 8px vertical bar on the left edge of a Live Orders card that
 * encodes the entry channel by color (design decision 1 in the walk-in
 * spec — we picked strip over chip after prototyping both).
 *
 * `bg-brand` for QR sessions, `bg-s-faint` for walk-ins. The card
 * still carries an icon+label row underneath so the info isn't
 * color-only.
 */
export function ChannelStrip({
  channel,
  className,
}: {
  channel: 'qr' | 'walkin';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        'absolute left-0 top-0 bottom-0 w-2 rounded-l-lg',
        channel === 'qr' ? 'bg-brand' : 'bg-s-faint',
        className,
      )}
    />
  );
}
