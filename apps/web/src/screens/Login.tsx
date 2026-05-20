import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import type { User } from '@plate-clean/shared-types';

type Mode = 'sign-in' | 'sign-up';

export function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdult, setIsAdult] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path = mode === 'sign-in' ? '/auth/login' : '/auth/register';
      const payload =
        mode === 'sign-in'
          ? { email, password }
          : { email, password, display_name: displayName, is_adult: isAdult };
      const res = await api.post<{ user: User; token: string }>(path, payload);
      setAuth(res.user, res.token);
      navigate('/scan');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError('Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">{mode === 'sign-in' ? 'Welcome back' : 'Create your account'}</h1>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm text-slate-600">Email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        {mode === 'sign-up' && (
          <label className="block">
            <span className="text-sm text-slate-600">Display name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
        )}
        <label className="block">
          <span className="text-sm text-slate-600">Password</span>
          <input
            required
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        {mode === 'sign-up' && (
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              required
              checked={isAdult}
              onChange={(e) => setIsAdult(e.target.checked)}
              className="mt-1"
            />
            <span>I confirm I am 18 or older.</span>
          </label>
        )}
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white py-2 font-medium disabled:opacity-50"
        >
          {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button
        onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
        className="text-sm text-brand-700 hover:underline"
      >
        {mode === 'sign-in' ? "New here? Create an account" : 'Already have an account? Sign in'}
      </button>
    </section>
  );
}
