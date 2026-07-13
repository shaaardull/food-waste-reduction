import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { api } from './lib/api';
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
  ClipboardList,
  Settings as SettingsIcon,
  History,
  Bug,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Menu, X as CloseIcon } from 'lucide-react';
import { useAuthStore } from './lib/auth';
import { initialsFor } from './lib/user';
import { useApplyTheme } from './lib/theme';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from './lib/i18n';
import { useToasts } from './lib/toasts';
import { useChime } from './lib/chime';
import { Bell, BellOff } from 'lucide-react';
import { Toasts } from './components/Toasts';

/**
 * Staff shell — dark-rail layout, "Counter" surface.
 *
 * Front-door pages (login + admin onboard) skip the rail and render
 * full-bleed so unauthenticated users don't see staff chrome before
 * they sign in. Everything else hangs off the left rail with the
 * restaurant chip at the top and the language + sign-out controls
 * pinned to the bottom.
 */
const FRONT_DOOR = new Set([
  '/login',
  '/forgot-password',
  '/admin/restaurants/new',
  // Backdoor: full-bleed so the platform-owner surface doesn't
  // inherit the restaurant-scoped staff rail.
  '/-/platform',
  '/-/platform/qr-stickers',
  // Print sheet MUST be full-bleed — the browser print dialog would
  // otherwise include the staff rail in the printed PDF.
  '/-/platform/qr-print',
]);

export function App() {
  const loc = useLocation();
  const { user, activeRestaurant } = useAuthStore();
  useApplyTheme(activeRestaurant);
  const { t } = useTranslation();
  // Mobile drawer state. Closed by default on every route change so the
  // rail doesn't linger open after a staff taps a nav link.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    setDrawerOpen(false);
  }, [loc.pathname]);

  const isFrontDoor = FRONT_DOOR.has(loc.pathname);

  if (!user || isFrontDoor) {
    return (
      <div className="s-app min-h-full flex flex-col">
        <main className="flex-1 max-w-screen-md w-full mx-auto px-4 py-6">
          <Outlet />
        </main>
        <Toasts />
      </div>
    );
  }

  return (
    <div className="s-app min-h-full md:flex">
      {/* Mobile top bar — only visible below md. Hamburger opens the
          same rail as a slide-in drawer so the entire nav stays
          reachable on a phone. */}
      <div
        className="md:hidden sticky top-0 z-30 flex items-center gap-3 px-4 py-3 text-white shadow-sm"
        style={{ background: 'hsl(213 30% 13%)' }}
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t('app.open_menu')}
          className="w-9 h-9 rounded-md hover:bg-white/10 flex items-center justify-center"
        >
          <Menu size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-white/55 uppercase tracking-wide">
            {t('app.name_staff')}
          </div>
          <div className="font-semibold text-[14px] truncate">
            {activeRestaurant?.name ?? t('app.no_restaurant')}
          </div>
        </div>
      </div>

      {/* Desktop rail. md+ only. */}
      <div className="hidden md:block">
        <StaffRail />
      </div>

      {/* Mobile drawer + backdrop. Rendered when drawerOpen=true so a
          staff on a phone can reach every nav item. Slides in from the
          left, backdrop dismisses on tap. */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <button
            type="button"
            aria-label={t('app.close_menu')}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <div className="absolute left-0 top-0 bottom-0 animate-[slidein_.2s_ease-out]">
            <StaffRail onNavigate={() => setDrawerOpen(false)} showClose />
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 px-4 md:px-6 py-4 md:py-6">
        <div className="max-w-screen-xl mx-auto">
          <Outlet />
        </div>
      </main>
      <Toasts />
    </div>
  );
}

interface BadgeCounts {
  orders_active: number;
  validations_pending: number;
  disputes_open: number;
  rewards_issued_today: number;
}

function StaffRail({
  onNavigate,
  showClose,
}: {
  onNavigate?: () => void;
  showClose?: boolean;
} = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, token, restaurantId, clearAuth, activeRestaurant } = useAuthStore();
  const currentLang = (i18n.resolvedLanguage ?? 'en') as Language;

  // Live queue-depth counters for the sidebar. Polls every 15s so a
  // new order / dispute / after-capture that just landed shows up
  // without the staff having to click into that section first.
  // 15s is the sweet spot: fast enough to feel "live", cheap enough
  // that a single Postgres query on three COUNT(*)s doesn't hurt.
  // `staleTime: 0` because we always want the freshest number, and
  // `refetchOnWindowFocus: true` so a staff clicking back into the
  // tab sees an immediate refresh.
  const { data: badges } = useQuery<BadgeCounts>({
    queryKey: ['dashboard-badges', restaurantId],
    queryFn: () =>
      api.get<BadgeCounts>(
        `/restaurants/${restaurantId}/dashboard/badges`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    refetchInterval: 15_000,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  // Compare each poll to the previous to detect NEW events (rises
  // in a counter mean something just happened). A shared ref keeps
  // the last-seen values across renders without triggering re-runs.
  // First poll after mount seeds the ref without firing toasts —
  // otherwise the staff would see a wall of notifications for the
  // baseline state every time they open the dashboard.
  const pushToast = useToasts((s) => s.push);
  const playChime = useChime((s) => s.play);
  const prevBadges = useRef<BadgeCounts | null>(null);
  useEffect(() => {
    if (!badges) return;
    const prev = prevBadges.current;
    if (prev) {
      if (badges.orders_active > prev.orders_active) {
        const delta = badges.orders_active - prev.orders_active;
        pushToast({
          tone: 'brand',
          title: t('toasts.new_orders_title', { count: delta }),
          body: t('toasts.new_orders_body'),
          href: '/orders',
        });
        playChime('order');
      }
      if (badges.validations_pending > prev.validations_pending) {
        const delta = badges.validations_pending - prev.validations_pending;
        pushToast({
          tone: 'sage',
          title: t('toasts.new_validations_title', { count: delta }),
          body: t('toasts.new_validations_body'),
          href: '/validations',
        });
        playChime('validation');
      }
      if (badges.disputes_open > prev.disputes_open) {
        const delta = badges.disputes_open - prev.disputes_open;
        pushToast({
          tone: 'alert',
          title: t('toasts.new_disputes_title', { count: delta }),
          body: t('toasts.new_disputes_body'),
          href: '/disputes',
        });
        playChime('dispute');
      }
      if (badges.rewards_issued_today > prev.rewards_issued_today) {
        const delta =
          badges.rewards_issued_today - prev.rewards_issued_today;
        pushToast({
          tone: 'saffron',
          title: t('toasts.reward_claimed_title', { count: delta }),
          body: t('toasts.reward_claimed_body'),
          href: '/summary',
        });
        playChime('reward');
      }
    }
    prevBadges.current = badges;
  }, [badges, pushToast, playChime, t]);

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
    /** Live queue depth for this surface. Undefined = no badge. */
    count?: number;
    /** Colour hint for the badge — `alert` (red) for disputes so
     *  they visually stand out from the routine queue chips. */
    countTone?: 'default' | 'alert';
  }> = [
    { to: '/', label: t('app.nav.summary'), icon: <LayoutDashboard size={16} />, end: true },
    // `end: true` on Live orders — otherwise NavLink treats `/orders`
    // as active when the user is on `/orders/past` (prefix match),
    // and both items highlight simultaneously.
    {
      to: '/orders',
      label: t('app.nav.orders'),
      icon: <ClipboardList size={16} />,
      end: true,
      count: badges?.orders_active,
    },
    { to: '/orders/past', label: t('app.nav.past_orders'), icon: <History size={16} /> },
    {
      to: '/validations',
      label: t('app.nav.validations'),
      icon: <ListChecks size={16} />,
      count: badges?.validations_pending,
    },
    { to: '/menu', label: t('app.nav.menu'), icon: <Utensils size={16} /> },
    { to: '/redeem', label: t('app.nav.redeem'), icon: <Receipt size={16} /> },
    { to: '/analytics', label: t('app.nav.analytics'), icon: <TrendingUp size={16} /> },
    { to: '/staff-metrics', label: t('app.nav.staff_metrics'), icon: <Users size={16} /> },
    {
      to: '/disputes',
      label: t('app.nav.disputes'),
      icon: <MessageSquareWarning size={16} />,
      count: badges?.disputes_open,
      countTone: 'alert',
    },
    { to: '/settings', label: t('app.nav.settings'), icon: <SettingsIcon size={16} /> },
    { to: '/report-bug', label: t('app.nav.report_bug'), icon: <Bug size={16} /> },
    {
      to: '/admin/restaurants/new',
      label: t('app.nav.onboard'),
      icon: <Plus size={16} />,
      adminOnly: true,
    },
  ];

  // 99+ compression so a wall of pending disputes still fits the
  // narrow rail.
  function displayCount(n: number): string {
    return n > 99 ? '99+' : String(n);
  }

  return (
    <aside
      // sticky + h-screen keeps the language toggle and sign-out
      // pinned to the visible viewport bottom on long pages (Past
      // orders, Analytics, Staff metrics can all scroll well past
      // a laptop viewport). Without this the aside grows to match
      // the main content height and its footer scrolls off the
      // bottom of the window.
      className="w-[228px] shrink-0 flex flex-col text-white sticky top-0 h-screen"
      style={{ background: 'hsl(213 30% 13%)' }}
    >
      {/* Close button (mobile drawer only). Only shown when explicitly
          requested — the desktop rail has no close affordance since it
          isn't dismissable. */}
      {showClose && (
        <button
          type="button"
          onClick={onNavigate}
          aria-label={t('app.close_menu')}
          className="absolute top-3 right-3 w-8 h-8 rounded-md hover:bg-white/10 flex items-center justify-center text-white/80"
        >
          <CloseIcon size={16} />
        </button>
      )}
      {/* restaurant chip */}
      <Link
        to="/"
        onClick={onNavigate}
        className="px-4 pt-5 pb-4 flex items-center gap-2.5 hover:opacity-90 transition"
      >
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
              onClick={onNavigate}
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
              <span className="truncate flex-1">{it.label}</span>
              {/* Live queue-depth pill. Rendered only when the count
                  is a positive number — zero and undefined both hide
                  the pill so the rail stays quiet when nothing's
                  waiting. */}
              {typeof it.count === 'number' && it.count > 0 && (
                <span
                  aria-label={`${it.count} waiting`}
                  className={clsx(
                    'shrink-0 min-w-[22px] h-[20px] px-1.5 rounded-full',
                    'flex items-center justify-center',
                    'text-[11px] font-bold tnum leading-none',
                    it.countTone === 'alert'
                      ? 'bg-danger text-white'
                      : 'bg-brand text-white',
                  )}
                >
                  {displayCount(it.count)}
                </span>
              )}
            </NavLink>
          ))}
      </nav>

      {/* lang + user footer */}
      <div className="px-3 py-3 border-t border-white/10 flex flex-col gap-3">
        <div className="row gap-2 items-center">
          <div className="inline-flex gap-0.5 rounded-full p-0.5 bg-white/10 border border-white/15">
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
          <ChimeToggle />
        </div>
        {user && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-[12px] font-semibold">
              {initialsFor(user)}
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

/**
 * Small bell / bell-off toggle wired to the chime store. Clicking it
 * also serves as the "user gesture" that unlocks the AudioContext,
 * so the very first event of the shift plays without a delay.
 */
function ChimeToggle() {
  const { t } = useTranslation();
  const muted = useChime((s) => s.muted);
  const toggle = useChime((s) => s.toggle);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={!muted}
      aria-label={
        muted
          ? t('app.chime.unmute', { defaultValue: 'Turn sound on' })
          : t('app.chime.mute', { defaultValue: 'Turn sound off' })
      }
      title={
        muted
          ? t('app.chime.unmute', { defaultValue: 'Turn sound on' })
          : t('app.chime.mute', { defaultValue: 'Turn sound off' })
      }
      className={clsx(
        'w-7 h-7 rounded-full flex items-center justify-center border transition',
        muted
          ? 'bg-white/5 border-white/15 text-white/55 hover:text-white'
          : 'bg-brand/20 border-brand/40 text-white hover:bg-brand/30',
      )}
    >
      {muted ? <BellOff size={13} /> : <Bell size={13} />}
    </button>
  );
}
