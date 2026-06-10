import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

/**
 * Pill-shaped EN / हि / म language toggle. Shows up on the Landing hero
 * (over the dish photo — `dark` variant) and on regular screens (light
 * variant against the cream background). Reads the resolved language
 * directly from i18next so it stays in sync with the SUPPORTED_LANGUAGES
 * set wired up in lib/i18n.ts.
 */
const LANGS: Array<{ code: 'en' | 'hi' | 'mr'; label: string }> = [
  { code: 'en', label: 'EN' },
  { code: 'hi', label: 'हि' },
  { code: 'mr', label: 'म' },
];

interface LangToggleProps {
  /** Use the photo-overlay variant (white text, translucent bg). */
  dark?: boolean;
  className?: string;
}

export function LangToggle({ dark = false, className }: LangToggleProps) {
  const { i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? 'en').slice(0, 2);

  return (
    <div
      className={clsx(
        'inline-flex gap-0.5 rounded-full p-0.5 border',
        dark
          ? 'bg-black/30 border-white/25'
          : 'bg-paper border-line',
        className,
      )}
    >
      {LANGS.map(({ code, label }) => {
        const active = current === code;
        return (
          <button
            key={code}
            onClick={() => void i18n.changeLanguage(code)}
            className={clsx(
              'min-w-[30px] h-7 px-2 rounded-full font-semibold text-[13px] dev transition',
              active
                ? 'bg-brand text-white'
                : dark
                  ? 'text-white/90 hover:bg-white/10'
                  : 'text-ink/70 hover:text-ink',
            )}
            aria-pressed={active}
            aria-label={`Switch to ${label}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
