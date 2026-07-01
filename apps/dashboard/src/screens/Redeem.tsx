import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Receipt, Utensils, Check, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
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

/**
 * Redeem — cashier-side lookup of a diner's redemption code. Search,
 * confirm the code matches the table they're sitting at, then mark
 * it redeemed at the current value.
 */
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
      if ((err as ApiException).message) setError((err as ApiException).message);
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
      if ((err as ApiException).message) setError((err as ApiException).message);
    }
  }

  const r = lookup?.reward;
  const expired = r ? new Date(r.expires_at) <= new Date() : false;
  const inHalfWindow = r ? !expired && new Date(r.half_value_at) <= new Date() : false;
  const valueNow = r ? r.current_value_minor ?? r.value_minor : 0;

  return (
    <section className="max-w-xl mx-auto flex flex-col gap-4">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.nav.redeem')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('redeem.title')}
        </h1>
      </header>

      <form onSubmit={search} className="row gap-2">
        <div className="flex-1 relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-s-muted pointer-events-none"
          />
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('redeem.code_placeholder')}
            className="input pl-9 font-mono tracking-wider uppercase"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary min-h-[44px] px-5 disabled:opacity-50"
        >
          {t('redeem.lookup')}
        </button>
      </form>

      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {r && lookup && (
        <article className="bg-s-paper border border-s-line rounded-lg overflow-hidden">
          {/* code header */}
          <div className="bg-s-bg/60 px-5 py-4 row spread items-center border-b border-s-line">
            <div>
              <div className="text-[11px] font-semibold text-s-muted dev uppercase tracking-wide">
                {t('redeem.table', { code: lookup.session.table_code })}
              </div>
              <div className="code text-[22px] mt-0.5">{r.redemption_code}</div>
            </div>
            <RewardStatusChip
              expired={expired}
              voided={Boolean(r.voided_at)}
              redeemedAt={r.redeemed_at}
              t={t}
            />
          </div>

          {/* details */}
          <div className="px-5 py-4 flex flex-col gap-3">
            {/* reward-type card */}
            <div
              className={clsx(
                'rounded-md p-3 flex flex-col gap-1.5',
                r.reward_type === 'bill_discount'
                  ? 'bg-amber-wash text-amber-deep'
                  : 'bg-brand-wash text-brand',
              )}
            >
              <div className="row gap-2 items-center font-semibold text-[14px]">
                {r.reward_type === 'bill_discount' ? (
                  <Receipt size={16} />
                ) : (
                  <Utensils size={16} />
                )}
                {t(`redeem.type.${r.reward_type}`)}
              </div>
              <div className="text-[12.5px] opacity-80">
                {t(`redeem.instruction.${r.reward_type}`)}
              </div>
              <div className="text-[14px] mt-1">
                {t('redeem.pay_out_label')}:{' '}
                <span className="tnum font-bold text-[18px]">
                  {formatValue(valueNow)}
                </span>
                {inHalfWindow && (
                  <span className="ml-2 chip chip-amber">{t('redeem.half_value')}</span>
                )}
              </div>
            </div>

            {/* meta lines */}
            <div className="flex flex-col gap-1 text-[12.5px] text-s-muted">
              <div className="row gap-1.5 items-center">
                <Clock size={12} />
                <span>
                  {t('redeem.issued_expires', {
                    issued: new Date(r.issued_at).toLocaleDateString(),
                    expires: new Date(r.expires_at).toLocaleDateString(),
                  })}
                </span>
              </div>
              {lookup.score !== null && (
                <div className="row gap-1.5 items-center">
                  <Check size={12} className="text-sage" />
                  <span>
                    {t('redeem.final_score', { percent: Math.round(lookup.score * 100) })}
                  </span>
                </div>
              )}
            </div>

            {/* action */}
            {r.redeemed_at ? (
              <div className="confbanner bg-sage-wash text-sage rounded-md">
                <Check size={16} />
                <span>
                  {r.redeemed_value_minor != null
                    ? t('redeem.already_redeemed_amount', {
                        when: new Date(r.redeemed_at).toLocaleString(),
                        amount: formatValue(r.redeemed_value_minor),
                      })
                    : t('redeem.already_redeemed', {
                        when: new Date(r.redeemed_at).toLocaleString(),
                      })}
                </span>
              </div>
            ) : r.voided_at ? (
              <div className="confbanner bg-danger-wash text-danger rounded-md">
                <span>{t('redeem.voided')}</span>
              </div>
            ) : expired ? (
              <div className="confbanner bg-danger-wash text-danger rounded-md">
                <span>{t('redeem.expired')}</span>
              </div>
            ) : (
              <button
                onClick={redeem}
                className="btn btn-primary btn-block min-h-[48px]"
              >
                <Check size={16} />
                {t('redeem.mark_redeemed', { amount: formatValue(valueNow) })}
              </button>
            )}
          </div>
        </article>
      )}
    </section>
  );
}

interface StatusChipProps {
  expired: boolean;
  voided: boolean;
  redeemedAt: string | null;
  t: ReturnType<typeof useTranslation>['t'];
}

function RewardStatusChip({ expired, voided, redeemedAt, t }: StatusChipProps) {
  if (redeemedAt) {
    return (
      <span className="chip chip-sage">
        <Check size={11} />
        {t('redeem.status_used')}
      </span>
    );
  }
  if (voided) {
    return <span className="chip chip-danger">{t('redeem.voided')}</span>;
  }
  if (expired) {
    return <span className="chip chip-muted">{t('redeem.expired')}</span>;
  }
  return <span className="chip chip-brand">{t('redeem.status_ready')}</span>;
}
