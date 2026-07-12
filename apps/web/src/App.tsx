import { Link, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from './lib/auth';
import { useApplyTheme } from './lib/theme';
import { useNewRewardsBadge } from './lib/newRewards';
import { useLiveSessionsCount } from './lib/liveSessions';

/**
 * Front-door screens (`/`, `/login`, `/quick-start`, `/stats`) bring their
 * own chrome — a full-bleed hero or a centred form — so we hide the App
 * header on those routes. Everything past auth (scan, order, capture,
 * status, rewards, profile) keeps the existing branded header.
 */
const FRONT_DOOR_ROUTES = new Set([
  '/',
  '/login',
  '/forgot-password',
  '/quick-start',
  '/onboard-choice',
  '/stats',
]);

export function App() {
  const { t } = useTranslation();
  const loc = useLocation();
  // We key the nav off `token` (not `user`) so anonymous quick-start
  // diners — who have a JWT but no full user row — still see Rewards
  // and Profile on every screen they can reach post-scan.
  const token = useAuthStore((s) => s.token);
  const activeRestaurant = useAuthStore((s) => s.activeRestaurant);
  useApplyTheme(activeRestaurant);
  const { count: newRewards, markSeen: markRewardsSeen } = useNewRewardsBadge();
  const liveSessions = useLiveSessionsCount();

  // `/qr/:token` is dynamic (Set can't hold a pattern), so we
  // prefix-match it as an additional front-door route. Everything
  // else stays a strict membership check.
  const fullBleed =
    FRONT_DOOR_ROUTES.has(loc.pathname) || loc.pathname.startsWith('/qr/');

  return (
    <div className="min-h-full flex flex-col">
      {!fullBleed && (
        <header className="bg-brand text-white px-4 py-3 shadow-sh-sm">
          <div className="max-w-screen-sm mx-auto flex items-center justify-between">
            <Link
              to="/"
              className="font-semibold tracking-tight flex items-center gap-2"
            >
              {activeRestaurant?.theme_logo_url && (
                <img
                  src={activeRestaurant.theme_logo_url}
                  alt=""
                  className="h-6 w-6 rounded object-cover bg-white/10"
                />
              )}
              <span>{activeRestaurant?.name ?? t('app.name')}</span>
            </Link>
            <nav className="flex gap-3 text-sm">
              {token ? (
                <>
                  <Link
                    to="/sessions"
                    className="hover:underline relative inline-flex items-center gap-1.5"
                  >
                    <span>{t('app.nav.sessions')}</span>
                    {liveSessions > 0 && (
                      <span
                        aria-label={t('app.nav.sessions_live_aria', {
                          count: liveSessions,
                          defaultValue: `${liveSessions} live`,
                        })}
                        className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-white text-brand text-[11px] font-bold leading-none tnum"
                      >
                        {liveSessions > 99 ? '99+' : liveSessions}
                      </span>
                    )}
                  </Link>
                  <Link
                    to="/rewards"
                    onClick={markRewardsSeen}
                    className="hover:underline relative inline-flex items-center gap-1.5"
                  >
                    <span>{t('app.nav.rewards')}</span>
                    {newRewards > 0 && (
                      <span
                        aria-label={t('app.nav.rewards_new_aria', {
                          count: newRewards,
                          defaultValue: `${newRewards} new`,
                        })}
                        className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-saffron-deep text-white text-[11px] font-bold leading-none tnum"
                      >
                        {newRewards > 99 ? '99+' : newRewards}
                      </span>
                    )}
                  </Link>
                  <Link to="/profile" className="hover:underline">
                    {t('app.nav.profile')}
                  </Link>
                </>
              ) : loc.pathname !== '/login' ? (
                <Link to="/login" className="hover:underline">
                  {t('app.nav.sign_in')}
                </Link>
              ) : null}
            </nav>
          </div>
          {activeRestaurant?.tagline && (
            <div className="max-w-screen-sm mx-auto text-xs text-white/80 mt-1">
              {activeRestaurant.tagline}
            </div>
          )}
        </header>
      )}
      <main
        className={
          fullBleed
            ? 'flex-1 w-full mx-auto max-w-screen-sm'
            : 'flex-1 max-w-screen-sm w-full mx-auto px-4 py-5'
        }
      >
        <Outlet />
      </main>
      {!fullBleed && (
        <footer className="text-center text-xs text-muted py-4">
          {t('app.footer')}
        </footer>
      )}
    </div>
  );
}
