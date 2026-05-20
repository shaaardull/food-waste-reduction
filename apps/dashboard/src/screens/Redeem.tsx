import { useState } from 'react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface Lookup {
  reward: {
    redemption_code: string;
    issued_at: string;
    expires_at: string;
    redeemed_at: string | null;
    voided_at: string | null;
  };
  session: { id: string; status: string; table_code: string };
  score: number | null;
}

export function Redeem() {
  const token = useAuthStore((s) => s.token);
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.get<Lookup>(`/rewards/${encodeURIComponent(code.trim())}`, token);
      setLookup(res);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      setLookup(null);
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    if (!lookup) return;
    setError(null);
    try {
      await api.post(
        `/rewards/${encodeURIComponent(lookup.reward.redemption_code)}/redeem`,
        undefined,
        token,
      );
      const res = await api.get<Lookup>(
        `/rewards/${encodeURIComponent(lookup.reward.redemption_code)}`,
        token,
      );
      setLookup(res);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    }
  }

  return (
    <section className="max-w-md mx-auto space-y-4">
      <h1 className="text-xl font-semibold">Redeem a reward code</h1>
      <form onSubmit={search} className="flex gap-2">
        <input
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="PLATE-XXXX"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 disabled:opacity-50"
        >
          Look up
        </button>
      </form>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {lookup && (
        <div className="rounded-lg bg-white border border-slate-200 p-3 space-y-2 text-sm">
          <p className="font-mono text-lg">{lookup.reward.redemption_code}</p>
          <p className="text-slate-600">Table {lookup.session.table_code}</p>
          <p className="text-slate-600">
            Issued {new Date(lookup.reward.issued_at).toLocaleString()} · expires{' '}
            {new Date(lookup.reward.expires_at).toLocaleString()}
          </p>
          {lookup.score !== null && (
            <p className="text-slate-600">Final score: {Math.round(lookup.score * 100)}%</p>
          )}
          {lookup.reward.redeemed_at ? (
            <p className="text-amber-700">
              Already redeemed at {new Date(lookup.reward.redeemed_at).toLocaleString()}.
            </p>
          ) : lookup.reward.voided_at ? (
            <p className="text-red-700">Voided.</p>
          ) : (
            <button
              onClick={redeem}
              className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2"
            >
              Mark redeemed
            </button>
          )}
        </div>
      )}
    </section>
  );
}
