import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from './lib/auth';
import { useApplyTheme } from './lib/theme';

export function App() {
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
                {activeRestaurant ? `${activeRestaurant.name} · Staff` : 'Plate-Clean · Staff'}
              </span>
            </Link>
            {user && (
              <nav className="flex gap-4 text-sm">
                <Link to="/validations" className="hover:underline">
                  Validation queue
                </Link>
                <Link to="/redeem" className="hover:underline">
                  Redeem code
                </Link>
                <Link to="/" className="hover:underline">
                  Summary
                </Link>
                {user.role === 'admin' && (
                  <Link to="/admin/restaurants/new" className="hover:underline">
                    Onboard restaurant
                  </Link>
                )}
              </nav>
            )}
          </div>
          {user ? (
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <span>{user.display_name ?? user.email}</span>
              <button
                onClick={() => {
                  clearAuth();
                  navigate('/login');
                }}
                className="text-slate-500 hover:underline"
              >
                Sign out
              </button>
            </div>
          ) : loc.pathname !== '/login' ? (
            <Link to="/login" className="text-sm text-brand-700 hover:underline">
              Sign in
            </Link>
          ) : null}
        </div>
      </header>
      <main className="flex-1 max-w-screen-xl w-full mx-auto px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
