import { Link, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from './lib/auth';
import { useApplyTheme } from './lib/theme';

/**
 * Front-door screens (`/`, `/login`, `/quick-start`, `/stats`) bring their
 * own chrome — a full-bleed hero or a centred form — so we hide the App
 * header on those routes. Everything past auth (scan, order, capture,
 * status, rewards, profile) keeps the existing branded header.
 */
const FRONT_DOOR_ROUTES = new Set(['/', '/login', '/quick-start', '/stats']);

export function App() {
  const { t } = useTranslation();
  const loc = useLocation();
  // We key the nav off `token` (not `user`) so anonymous quick-start
  // diners — who have a JWT but no full user row — still see Rewards
  // and Profile on every screen they can reach post-scan.
  const token = useAuthStore((s) => s.token);
  const activeRestaurant = useAuthStore((s) => s.activeRestaurant);
  useApplyTheme(activeRestaurant);

  const fullBleed = FRONT_DOOR_ROUTES.has(loc.pathname);

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
                  <Link to="/rewards" className="hover:underline">
                    {t('app.nav.rewards')}
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
