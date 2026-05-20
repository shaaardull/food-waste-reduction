import { Link } from 'react-router-dom';
import { useAuthStore } from '../lib/auth';

export function Landing() {
  const user = useAuthStore((s) => s.user);
  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-brand-700">Finish your plate, unlock a reward.</h1>
        <p className="text-slate-600">
          Snap a photo when you sit down, and another before you ask for the bill. A server reviews it.
          If you cleared most of what you ordered, the kitchen sends a small treat your way.
        </p>
      </header>
      <div className="flex flex-col gap-3">
        {user ? (
          <Link
            to="/scan"
            className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
          >
            Scan your table QR
          </Link>
        ) : (
          <Link
            to="/login"
            className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
          >
            Sign in to start
          </Link>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Less food into the bin means less methane out of it. That's the only scoreboard we keep.
      </p>
    </section>
  );
}
