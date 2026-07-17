import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Ban } from 'lucide-react';
import { useAuthStore } from '../lib/auth';
import { useNotStaffStore } from '../lib/notStaff';

/**
 * Full-screen error rendered when the backend answers a staff-scoped
 * call with 403 NOT_RESTAURANT_STAFF. Kept minimal on purpose — this
 * is a rare corner (misconfigured staff, revoked membership, wrong
 * account) and every second on it is a second the user isn't doing
 * their actual job.
 */
export function NotStaffOfRestaurant() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const { restaurantSlug, restaurantId, clear } = useNotStaffStore();

  // If the user landed here without a triggered error (bookmark,
  // deep-link), send them back to Summary rather than a stuck screen.
  useEffect(() => {
    return () => {
      clear();
    };
  }, [clear]);

  const contextLine =
    restaurantSlug ?? restaurantId ?? null;

  const supportSubject = t('errors.not_on_staff.support_subject');
  const supportBody = contextLine
    ? t('errors.not_on_staff.support_body_with_context', { context: contextLine })
    : t('errors.not_on_staff.support_body');
  const mailto = `mailto:hello@plateclean.in?subject=${encodeURIComponent(supportSubject)}&body=${encodeURIComponent(supportBody)}`;

  function signOut() {
    clear();
    clearAuth();
    navigate('/login');
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md text-center flex flex-col items-center gap-5">
        <div className="w-14 h-14 rounded-full bg-mist flex items-center justify-center text-s-ink/60">
          <Ban size={26} strokeWidth={1.6} />
        </div>
        <h1 className="text-[22px] font-semibold text-s-ink leading-tight">
          {t('errors.not_on_staff.heading')}
        </h1>
        <p className="text-[14px] text-s-ink/70 leading-snug">
          {t('errors.not_on_staff.body')}
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-1">
          <button
            type="button"
            onClick={signOut}
            className="h-10 px-5 rounded-md bg-brand text-white font-semibold text-[13.5px] hover:opacity-95 transition"
          >
            {t('errors.not_on_staff.sign_out')}
          </button>
          <a
            href={mailto}
            className="h-10 px-5 rounded-md border border-s-ink/25 text-s-ink font-semibold text-[13.5px] hover:bg-mist transition inline-flex items-center"
          >
            {t('errors.not_on_staff.contact_support')}
          </a>
        </div>
        {contextLine && (
          <p className="text-[11.5px] text-s-ink/45 pt-3">
            {t('errors.not_on_staff.context_line', { context: contextLine })}
          </p>
        )}
      </div>
    </div>
  );
}
