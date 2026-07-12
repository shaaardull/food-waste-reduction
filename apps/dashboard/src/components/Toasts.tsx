import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  ClipboardList,
  ListChecks,
  MessageSquareWarning,
  Sparkles,
  X,
} from 'lucide-react';
import { useToasts, type Toast, type ToastTone } from '../lib/toasts';

/**
 * Toast renderer — mounted once at the App root, subscribes to the
 * Zustand queue. Cards stack top-right, animate in with a subtle
 * slide + fade, auto-dismiss after ttlMs (default 4.5s).
 *
 * Tones map to the four surfaces we care about:
 *   • brand  — new live order landed
 *   • saffron — a reward was just issued (celebration)
 *   • sage   — validation queue got a new entry
 *   • alert  — a dispute was raised (needs owner attention)
 *
 * Kept as a light client-only component; z-50 ensures it floats
 * above the sticky rail and any modals.
 */

const toneStyles: Record<
  ToastTone,
  { border: string; iconBg: string; iconColor: string; accent: string }
> = {
  brand: {
    border: 'border-brand/30',
    iconBg: 'bg-brand-wash',
    iconColor: 'text-brand',
    accent: 'text-brand',
  },
  sage: {
    border: 'border-sage/30',
    iconBg: 'bg-sage-wash',
    iconColor: 'text-sage',
    accent: 'text-sage',
  },
  saffron: {
    border: 'border-saffron-deep/30',
    iconBg: 'bg-saffron-wash',
    iconColor: 'text-saffron-deep',
    accent: 'text-saffron-deep',
  },
  alert: {
    border: 'border-danger/30',
    iconBg: 'bg-danger-wash',
    iconColor: 'text-danger',
    accent: 'text-danger',
  },
};

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-50 top-4 right-4 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const style = toneStyles[toast.tone];
  const icon = iconFor(toast.tone);

  const inner = (
    <div
      className={clsx(
        'pointer-events-auto',
        'w-[300px] rounded-lg border bg-s-paper shadow-pop',
        'flex gap-3 items-start p-3',
        'animate-[slidein_.24s_ease-out]',
        style.border,
      )}
      role="status"
    >
      <span
        className={clsx(
          'shrink-0 w-9 h-9 rounded-md flex items-center justify-center',
          style.iconBg,
          style.iconColor,
        )}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-[13.5px] text-s-ink leading-tight">
          {toast.title}
        </div>
        {toast.body && (
          <div className="text-[12px] text-s-muted mt-0.5 leading-snug">
            {toast.body}
          </div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.preventDefault();
          dismiss(toast.id);
        }}
        className="shrink-0 text-s-muted hover:text-s-ink w-6 h-6 rounded-md hover:bg-s-bg flex items-center justify-center"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );

  // Wrap in Link if href — clicking the card navigates. Dismiss
  // button is inside the Link so we stopPropagation on it above.
  if (toast.href) {
    return (
      <Link to={toast.href} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}

function iconFor(tone: ToastTone) {
  switch (tone) {
    case 'brand':
      return <ClipboardList size={17} />;
    case 'sage':
      return <ListChecks size={17} />;
    case 'saffron':
      return <Sparkles size={17} />;
    case 'alert':
      return <MessageSquareWarning size={17} />;
  }
}
