import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

type RewardType = 'menu_item' | 'bill_discount';

interface RewardBody {
  id: string;
  redemption_code: string;
  reward_type: RewardType;
  value_minor: number;
  current_value_minor?: number;
  issued_at: string;
  half_value_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_value_minor: number | null;
  voided_at: string | null;
}

interface Lookup {
  reward: RewardBody;
  session: { id: string; status: string; table_code: string };
  score: number | null;
}

function formatValue(minor: number): string {
  return `₹${(minor / 100).toFixed(0)}`;
}

export function Redeem() {
  const { t } = useTranslation();
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

  const r = lookup?.reward;
  const expired = r ? new Date(r.expires_at) <= new Date() : false;
  const inHalfWindow = r ? !expired && new Date(r.half_value_at) <= new Date() : false;
  const valueNow = r ? r.current_value_minor ?? r.value_minor : 0;

  return (
    <section className="max-w-md mx-auto space-y-4">
      <h1 className="text-xl font-semibold">{t('redeem.title')}</h1>
      <form onSubmit={search} className="flex gap-2">
        <input
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t('redeem.code_placeholder')}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 disabled:opacity-50"
        >
          {t('redeem.lookup')}
        </button>
      </form>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {r && lookup && (
        <div className="rounded-lg bg-white border border-slate-200 p-3 space-y-2 text-sm">
          <p className="font-mono text-lg">{r.redemption_code}</p>
          <p className="text-slate-600">{t('redeem.table', { code: lookup.session.table_code })}</p>

          <div
            className={`rounded-md p-2 text-sm ${
              r.reward_type === 'bill_discount'
                ? 'bg-amber-50 border border-amber-200'
                : 'bg-brand-50 border border-brand-600/30'
            }`}
          >
            <div className="font-medium">{t(`redeem.type.${r.reward_type}`)}</div>
            <div className="text-xs text-slate-600">{t(`redeem.instruction.${r.reward_type}`)}</div>
            <div className="mt-1">
              {t('redeem.pay_out_label')}: <span className="font-semibold">{formatValue(valueNow)}</span>
              {inHalfWindow && (
                <span className="ml-2 text-amber-700 text-xs">{t('redeem.half_value')}</span>
              )}
            </div>
          </div>

          <p className="text-slate-600">
            {t('redeem.issued_expires', {
              issued: new Date(r.issued_at).toLocaleDateString(),
              expires: new Date(r.expires_at).toLocaleDateString(),
            })}
          </p>
          {lookup.score !== null && (
            <p className="text-slate-600">
              {t('redeem.final_score', { percent: Math.round(lookup.score * 100) })}
            </p>
          )}
          {r.redeemed_at ? (
            <p className="text-amber-700">
              {r.redeemed_value_minor != null
                ? t('redeem.already_redeemed_amount', {
                    when: new Date(r.redeemed_at).toLocaleString(),
                    amount: formatValue(r.redeemed_value_minor),
                  })
                : t('redeem.already_redeemed', {
                    when: new Date(r.redeemed_at).toLocaleString(),
                  })}
            </p>
          ) : r.voided_at ? (
            <p className="text-red-700">{t('redeem.voided')}</p>
          ) : expired ? (
            <p className="text-red-700">{t('redeem.expired')}</p>
          ) : (
            <button
              onClick={redeem}
              className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2"
            >
              {t('redeem.mark_redeemed', { amount: formatValue(valueNow) })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
