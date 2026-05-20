import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from './lib/auth';

export function App() {
  const navigate = useNavigate();
  const loc = useLocation();
  const { user, clearAuth, restaurantId } = useAuthStore();

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 py-3">
        <div className="max-w-screen-xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="font-semibold text-brand-700">
              Plate-Clean &mdash; Staff
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
              </nav>
            )}
          </div>
          {user ? (
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <span>
                {user.display_name ?? user.email}
                {restaurantId ? ` · ${restaurantId.slice(0, 8)}…` : ''}
              </span>
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
