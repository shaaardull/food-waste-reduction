import { Link, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from './lib/auth';
import { useApplyTheme } from './lib/theme';

export function App() {
  const loc = useLocation();
  const user = useAuthStore((s) => s.user);
  const activeRestaurant = useAuthStore((s) => s.activeRestaurant);
  useApplyTheme(activeRestaurant);

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-brand-700 text-white px-4 py-3 shadow">
        <div className="max-w-screen-sm mx-auto flex items-center justify-between">
          <Link to="/" className="font-semibold tracking-tight flex items-center gap-2">
            {activeRestaurant?.theme_logo_url && (
              <img
                src={activeRestaurant.theme_logo_url}
                alt=""
                className="h-6 w-6 rounded object-cover bg-white/10"
              />
            )}
            <span>{activeRestaurant?.name ?? 'Plate-Clean'}</span>
          </Link>
          <nav className="flex gap-3 text-sm">
            {user ? (
              <>
                <Link to="/rewards" className="hover:underline">
                  Rewards
                </Link>
                <Link to="/profile" className="hover:underline">
                  Profile
                </Link>
              </>
            ) : loc.pathname !== '/login' ? (
              <Link to="/login" className="hover:underline">
                Sign in
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
      <main className="flex-1 max-w-screen-sm w-full mx-auto px-4 py-5">
        <Outlet />
      </main>
      <footer className="text-center text-xs text-slate-500 py-4">
        Finishing a meal isn't a moral test &mdash; it's a small win for the planet.
      </footer>
    </div>
  );
}
