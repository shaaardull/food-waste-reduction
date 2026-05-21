import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from './lib/auth';
import { useApplyTheme } from './lib/theme';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from './lib/i18n';

export function App() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const loc = useLocation();
  const { user, clearAuth, activeRestaurant } = useAuthStore();
  useApplyTheme(activeRestaurant);

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 py-3">
        <div className="max-w-screen-xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="font-semibold text-brand-700 flex items-center gap-2">
              {activeRestaurant?.theme_logo_url && (
                <img
                  src={activeRestaurant.theme_logo_url}
                  alt=""
                  className="h-6 w-6 rounded object-cover"
                />
              )}
              <span>
                {activeRestaurant
                  ? t('app.with_restaurant', { name: activeRestaurant.name })
                  : t('app.name_staff')}
              </span>
            </Link>
            {user && (
              <nav className="flex gap-4 text-sm">
                <Link to="/validations" className="hover:underline">
                  {t('app.nav.validations')}
                </Link>
                <Link to="/redeem" className="hover:underline">
                  {t('app.nav.redeem')}
                </Link>
                <Link to="/" className="hover:underline">
                  {t('app.nav.summary')}
                </Link>
                <Link to="/staff-metrics" className="hover:underline">
                  {t('app.nav.staff_metrics')}
                </Link>
                <Link to="/disputes" className="hover:underline">
                  {t('app.nav.disputes')}
                </Link>
                {user.role === 'admin' && (
                  <Link to="/admin/restaurants/new" className="hover:underline">
                    {t('app.nav.onboard')}
                  </Link>
                )}
              </nav>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <select
              value={(i18n.resolvedLanguage ?? 'en') as Language}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
              className="border border-slate-200 rounded px-2 py-1 text-xs"
              aria-label="language"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {LANGUAGE_LABELS[lang]}
                </option>
              ))}
            </select>
            {user ? (
              <>
                <span>{user.display_name ?? user.email}</span>
                <button
                  onClick={() => {
                    clearAuth();
                    navigate('/login');
                  }}
                  className="text-slate-500 hover:underline"
                >
                  {t('app.nav.sign_out')}
                </button>
              </>
            ) : loc.pathname !== '/login' ? (
              <Link to="/login" className="text-brand-700 hover:underline">
                {t('app.nav.sign_in')}
              </Link>
            ) : null}
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-screen-xl w-full mx-auto px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
