import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

export function Profile() {
  const navigate = useNavigate();
  const { user, token, clearAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signOut() {
    try {
      await api.post('/auth/logout', undefined, token);
    } catch {
      /* ignore */
    }
    clearAuth();
    navigate('/');
  }

  async function deleteAccount() {
    if (!confirm('Delete your account and all associated data? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      await api.del('/auth/me', token);
      clearAuth();
      navigate('/');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      setBusy(false);
    }
  }

  if (!user) return <p className="text-slate-600">Sign in first.</p>;

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">Profile</h1>
      <div className="rounded-lg border border-slate-200 p-3 text-sm">
        <p>
          <span className="text-slate-500">Email:</span> {user.email}
        </p>
        <p>
          <span className="text-slate-500">Role:</span> {user.role}
        </p>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        onClick={signOut}
        className="w-full rounded-md border border-slate-300 py-2"
      >
        Sign out
      </button>
      <button
        onClick={deleteAccount}
        disabled={busy}
        className="w-full rounded-md border border-red-300 text-red-700 py-2 disabled:opacity-50"
      >
        Delete my account
      </button>
      <p className="text-xs text-slate-500">
        Deletion happens within 7 days. Photos from your sessions are removed too.
      </p>
    </section>
  );
}
