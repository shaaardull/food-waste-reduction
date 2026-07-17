import { ShoppingBag } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

/**
 * Saffron pill rendered in place of the table code on Live Orders
 * cards and the order-detail drawer when `session.is_takeaway` is
 * true. Takeaways are still walk-ins (gray channel strip) — only the
 * table binding changes.
 */
export function TakeawayPill({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full bg-saffron-wash text-saffron-deep px-2 py-0.5 text-xs font-semibold tracking-wide',
        className,
      )}
    >
      <ShoppingBag size={11} aria-hidden />
      {t('walkin.takeaway.pill_label')}
    </span>
  );
}
