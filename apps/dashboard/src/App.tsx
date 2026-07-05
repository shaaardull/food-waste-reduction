import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import {
  ListChecks,
  Receipt,
  LayoutDashboard,
  TrendingUp,
  Users,
  MessageSquareWarning,
  Plus,
  LogOut,
  Building2,
  Utensils,
} from 'lucide-react';
import { useAuthStore } from './lib/auth';
import { useApplyTheme } from './lib/theme';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from './lib/i18n';

/**
 * Staff shell — dark-rail layout, "Counter" surface.
 *
 * Front-door pages (login + admin onboard) skip the rail and render
 * full-bleed so unauthenticated users don't see staff chrome before
 * they sign in. Everything else hangs off the left rail with the
 * restaurant chip at the top and the language + sign-out controls
 * pinned to the bottom.
 */
const FRONT_DOOR = new Set(['/login', '/admin/restaurants/new']);

export function App() {
  const loc = useLocation();
  const { user, activeRestaurant } = useAuthStore();
  useApplyTheme(activeRestaurant);

  const isFrontDoor = FRONT_DOOR.has(loc.pathname);

  if (!user || isFrontDoor) {
    return (
      <div className="s-app min-h-full flex flex-col">
        <main className="flex-1 max-w-screen-md w-full mx-auto px-4 py-6">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="s-app min-h-full flex">
      <StaffRail />
      <main className="flex-1 min-w-0 px-6 py-6">
        <div className="max-w-screen-xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function StaffRail() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, clearAuth, activeRestaurant } = useAuthStore();
  const currentLang = (i18n.resolvedLanguage ?? 'en') as Language;

  function signOut() {
    clearAuth();
    navigate('/login');
  }

  const items: Array<{
    to: string;
    label: string;
    icon: ReactNode;
    end?: boolean;
    adminOnly?: boolean;
  }> = [
    { to: '/', label: t('app.nav.summary'), icon: <LayoutDashboard size={16} />, end: true },
    { to: '/validations', label: t('app.nav.validations'), icon: <ListChecks size={16} /> },
    { to: '/menu', label: t('app.nav.menu'), icon: <Utensils size={16} /> },
    { to: '/redeem', label: t('app.nav.redeem'), icon: <Receipt size={16} /> },
    { to: '/analytics', label: t('app.nav.analytics'), icon: <TrendingUp size={16} /> },
    { to: '/staff-metrics', label: t('app.nav.staff_metrics'), icon: <Users size={16} /> },
    { to: '/disputes', label: t('app.nav.disputes'), icon: <MessageSquareWarning size={16} /> },
    {
      to: '/admin/restaurants/new',
      label: t('app.nav.onboard'),
      icon: <Plus size={16} />,
      adminOnly: true,
    },
  ];

  return (
    <aside
      className="w-[228px] shrink-0 flex flex-col text-white"
      style={{ background: 'hsl(213 30% 13%)' }}
    >
      {/* restaurant chip */}
      <Link to="/" className="px-4 pt-5 pb-4 flex items-center gap-2.5 hover:opacity-90 transition">
        <div className="w-9 h-9 rounded-md flex items-center justify-center overflow-hidden bg-white/10 border border-white/15">
          {activeRestaurant?.theme_logo_url ? (
            <img
              src={activeRestaurant.theme_logo_url}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <Building2 size={18} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-white/55 dev uppercase tracking-wide">
            {t('app.name_staff')}
          </div>
          <div className="font-semibold text-[14px] truncate">
            {activeRestaurant?.name ?? t('app.no_restaurant')}
          </div>
        </div>
      </Link>

      {/* nav items */}
      <nav className="flex-1 px-2 py-2 flex flex-col gap-0.5">
        {items
          .filter((it) => !it.adminOnly || user?.role === 'admin')
          .map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2.5 px-3 py-2 rounded-md text-[13.5px] font-semibold transition',
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-white/65 hover:bg-white/5 hover:text-white',
                )
              }
            >
              <span className="opacity-90">{it.icon}</span>
              <span className="truncate">{it.label}</span>
            </NavLink>
          ))}
      </nav>

      {/* lang + user footer */}
      <div className="px-3 py-3 border-t border-white/10 flex flex-col gap-3">
        <div className="inline-flex gap-0.5 rounded-full p-0.5 bg-white/10 border border-white/15 self-start">
          {SUPPORTED_LANGUAGES.map((lang) => {
            const active = currentLang === lang;
            return (
              <button
                key={lang}
                onClick={() => void i18n.changeLanguage(lang)}
                className={clsx(
                  'min-w-[30px] h-6 px-2 rounded-full font-semibold text-[12px] dev transition',
                  active ? 'bg-brand text-white' : 'text-white/85 hover:bg-white/10',
                )}
                aria-pressed={active}
              >
                {LANGUAGE_LABELS[lang]}
              </button>
            );
          })}
        </div>
        {user && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-[12px] font-semibold">
              {(user.display_name ?? user.email).slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold truncate">
                {user.display_name ?? user.email}
              </div>
              <div className="text-[11px] text-white/55 capitalize">{user.role}</div>
            </div>
            <button
              onClick={signOut}
              aria-label={t('app.nav.sign_out')}
              className="w-8 h-8 rounded-md hover:bg-white/10 flex items-center justify-center text-white/70 transition"
            >
              <LogOut size={14} />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
