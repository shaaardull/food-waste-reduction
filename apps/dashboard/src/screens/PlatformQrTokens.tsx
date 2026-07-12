import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Printer,
  QrCode,
  Package,
  Plus,
  Link as LinkIcon,
  X,
  Trash2,
  Filter,
  Check,
  Copy,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * PlatformQrTokens — admin surface for the QR sticker inventory.
 *
 * Wraps the four backend endpoints under `/admin/platform/qr-tokens`:
 *
 *   POST  /                        → mint N tokens (unassigned)
 *   GET   /?state=&batch=          → list, filterable
 *   POST  /{token}/bind            → assign to restaurant + table
 *   POST  /{token}/retire          → terminal state
 *
 * Backdoored under `/-/platform/qr-stickers` — no left-rail entry so a
 * curious server can't stumble in. Admins reach it via the direct URL
 * (or a link from the platform command centre).
 *
 * "Print sheet" opens `/-/platform/qr-print?…` in a new tab; that view
 * renders 6-per-A4 table-tent cards, browser print does the rest.
 */

// ── Types (mirror the backend response shape) ───────────────────────

type TokenState = 'unassigned' | 'assigned' | 'retired';

interface QRTokenRow {
  id: string;
  token: string;
  batch_label: string | null;
  state: TokenState;
  restaurant_id: string | null;
  restaurant_name: string | null;
  restaurant_slug: string | null;
  table_code: string | null;
  assigned_at: string | null;
  created_at: string;
}

interface RestaurantRow {
  id: string;
  name: string;
  slug: string;
}

// ── Screen ──────────────────────────────────────────────────────────

export function PlatformQrTokens() {
  const { t } = useTranslation();
  const { token: authToken, user } = useAuthStore();
  const qc = useQueryClient();

  const [stateFilter, setStateFilter] = useState<TokenState | 'all'>('all');
  const [batchFilter, setBatchFilter] = useState<string>('');
  const [bindingRow, setBindingRow] = useState<QRTokenRow | null>(null);
  const [retiringRow, setRetiringRow] = useState<QRTokenRow | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  if (user?.role !== 'admin') {
    return (
      <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
        {t('qr_tokens.admin_only')}
      </p>
    );
  }

  const listQuery = useQuery({
    queryKey: ['qr-tokens', stateFilter, batchFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (stateFilter !== 'all') params.set('state', stateFilter);
      if (batchFilter.trim()) params.set('batch', batchFilter.trim());
      const qs = params.toString();
      return api.get<QRTokenRow[]>(
        `/admin/platform/qr-tokens${qs ? `?${qs}` : ''}`,
        authToken,
      );
    },
    enabled: Boolean(authToken),
  });

  const rows = listQuery.data ?? [];

  // Distinct batch labels for the filter dropdown — sourced from the
  // current list. Not paginated: if a batch was minted long ago and
  // filtered out of the view, the operator can type it in by hand.
  const batchLabels = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.batch_label) set.add(r.batch_label);
    return [...set].sort();
  }, [rows]);

  function copyToken(t: string) {
    void navigator.clipboard.writeText(t);
    setCopied(t);
    window.setTimeout(() => setCopied(null), 1500);
  }

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['qr-tokens'] });
  }

  return (
    <section className="flex flex-col gap-5">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
          <QrCode size={12} />
          {t('qr_tokens.eyebrow')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('qr_tokens.title')}
        </h1>
        <p className="text-[13px] text-s-muted mt-1 max-w-[62ch]">
          {t('qr_tokens.blurb')}
        </p>
      </header>

      <MintBatchForm authToken={authToken} onMinted={invalidate} />

      {/* Filter row */}
      <div className="row gap-2 items-center flex-wrap">
        <div className="row gap-1.5 items-center text-[12px] text-s-muted">
          <Filter size={12} />
          {t('qr_tokens.filter_state')}
        </div>
        {(['all', 'unassigned', 'assigned', 'retired'] as const).map((s) => {
          const active = stateFilter === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStateFilter(s)}
              className={clsx(
                'chip transition',
                active ? 'chip-brand' : 'chip-muted hover:bg-s-bg',
              )}
              aria-pressed={active}
            >
              {t(`qr_tokens.state_${s}`)}
            </button>
          );
        })}
        <div className="row gap-1 items-center ml-auto">
          <label className="text-[12px] text-s-muted">
            {t('qr_tokens.filter_batch')}
          </label>
          <input
            type="text"
            list="qr-batch-labels"
            value={batchFilter}
            onChange={(e) => setBatchFilter(e.target.value)}
            placeholder={t('qr_tokens.batch_all')}
            className="input mt-0 text-[13px] max-w-[200px]"
          />
          <datalist id="qr-batch-labels">
            {batchLabels.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
      </div>

      {listQuery.error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {(listQuery.error as Error).message}
        </p>
      )}

      {listQuery.isLoading && (
        <p className="text-s-muted text-[13px]">{t('qr_tokens.loading')}</p>
      )}

      {!listQuery.isLoading && rows.length === 0 && (
        <div className="empty rounded-lg border border-s-line bg-s-paper">
          <div className="art">
            <QrCode size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {t('qr_tokens.empty_title')}
          </p>
          <p className="text-[13px] text-s-muted mt-1.5 max-w-[42ch]">
            {t('qr_tokens.empty_blurb')}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-s-line bg-s-paper overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-s-line/60 text-[11px] uppercase tracking-wide text-s-muted">
                <th className="text-left px-3 py-2 font-semibold">
                  {t('qr_tokens.col_token')}
                </th>
                <th className="text-left px-3 py-2 font-semibold">
                  {t('qr_tokens.col_batch')}
                </th>
                <th className="text-left px-3 py-2 font-semibold">
                  {t('qr_tokens.col_state')}
                </th>
                <th className="text-left px-3 py-2 font-semibold">
                  {t('qr_tokens.col_restaurant')}
                </th>
                <th className="text-left px-3 py-2 font-semibold">
                  {t('qr_tokens.col_table')}
                </th>
                <th className="text-right px-3 py-2 font-semibold">
                  {t('qr_tokens.col_actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-s-line/40 last:border-0">
                  <td className="px-3 py-2 font-mono text-[12.5px]">
                    <button
                      type="button"
                      onClick={() => copyToken(r.token)}
                      className="row gap-1.5 items-center hover:text-brand transition"
                      title={t('qr_tokens.copy_token')}
                    >
                      <span>{r.token}</span>
                      {copied === r.token ? (
                        <Check size={11} className="text-sage" />
                      ) : (
                        <Copy size={11} className="text-s-muted opacity-70" />
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-s-muted">
                    {r.batch_label ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <StateChip state={r.state} t={t} />
                  </td>
                  <td className="px-3 py-2">
                    {r.restaurant_name ?? (
                      <span className="text-s-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">
                    {r.table_code ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="row gap-1 justify-end">
                      {r.state === 'unassigned' && (
                        <button
                          type="button"
                          onClick={() => setBindingRow(r)}
                          className="chip chip-brand"
                        >
                          <LinkIcon size={11} />
                          {t('qr_tokens.action_bind')}
                        </button>
                      )}
                      {r.state === 'assigned' && (
                        <button
                          type="button"
                          onClick={() => setRetiringRow(r)}
                          className="chip chip-danger"
                        >
                          <Trash2 size={11} />
                          {t('qr_tokens.action_retire')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Print sheet CTA — opens a new tab scoped to the current
          filter. Batch filter takes precedence over state filter for
          the URL so an operator who typed "spice-trail-oct" gets a
          sheet with exactly those cards. */}
      {rows.some((r) => r.state === 'assigned') && (
        <div className="row gap-2 items-center pt-2 border-t border-s-line/60">
          <button
            type="button"
            onClick={() => openPrintSheet(batchFilter)}
            className="btn btn-outline min-h-[40px] text-[13.5px] px-4"
          >
            <Printer size={14} />
            {t('qr_tokens.print_sheet_cta')}
          </button>
          <span className="text-[12px] text-s-muted">
            {t('qr_tokens.print_sheet_hint')}
          </span>
        </div>
      )}

      {bindingRow && (
        <BindModal
          authToken={authToken}
          row={bindingRow}
          onClose={() => setBindingRow(null)}
          onBound={() => {
            setBindingRow(null);
            invalidate();
          }}
        />
      )}
      {retiringRow && (
        <RetireModal
          authToken={authToken}
          row={retiringRow}
          onClose={() => setRetiringRow(null)}
          onRetired={() => {
            setRetiringRow(null);
            invalidate();
          }}
        />
      )}
    </section>
  );
}

function openPrintSheet(batch: string) {
  const params = new URLSearchParams();
  if (batch.trim()) params.set('batch', batch.trim());
  window.open(`/-/platform/qr-print?${params.toString()}`, '_blank');
}

function StateChip({
  state,
  t,
}: {
  state: TokenState;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const cls =
    state === 'assigned'
      ? 'chip-sage'
      : state === 'unassigned'
        ? 'chip-amber'
        : 'chip-muted';
  return <span className={`chip ${cls}`}>{t(`qr_tokens.state_${state}`)}</span>;
}

// ── Mint form ───────────────────────────────────────────────────────

function MintBatchForm({
  authToken,
  onMinted,
}: {
  authToken: string | null;
  onMinted: () => void;
}) {
  const { t } = useTranslation();
  const [count, setCount] = useState('20');
  const [batchLabel, setBatchLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<number | null>(null);

  const mint = useMutation({
    mutationFn: async () => {
      const n = Math.max(1, Math.min(500, parseInt(count, 10) || 0));
      const body: Record<string, string | number> = { count: n };
      if (batchLabel.trim()) body.batch_label = batchLabel.trim();
      const rows = await api.post<QRTokenRow[]>(
        '/admin/platform/qr-tokens',
        body,
        authToken,
      );
      return rows;
    },
    onSuccess: (rows) => {
      setMinted(rows.length);
      setBatchLabel('');
      onMinted();
      window.setTimeout(() => setMinted(null), 3_500);
    },
    onError: (e: ApiException) => setError(e.message ?? 'mint failed'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMinted(null);
    mint.mutate();
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-s-line bg-s-paper p-4 flex flex-col gap-3"
    >
      <div className="row gap-2 items-center">
        <Package size={16} className="text-brand" />
        <div className="font-semibold text-[15px] text-s-ink">
          {t('qr_tokens.mint_title')}
        </div>
      </div>
      <p className="text-[12.5px] text-s-muted leading-snug">
        {t('qr_tokens.mint_blurb')}
      </p>
      <div className="row gap-2 flex-wrap items-end">
        <label className="flex flex-col gap-1 min-w-[110px]">
          <span className="text-[12px] font-semibold text-s-ink">
            {t('qr_tokens.mint_count')}
          </span>
          <input
            type="number"
            min={1}
            max={500}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            className="input mt-0 tnum"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="text-[12px] font-semibold text-s-ink">
            {t('qr_tokens.mint_batch_label')}
          </span>
          <input
            type="text"
            maxLength={64}
            value={batchLabel}
            onChange={(e) => setBatchLabel(e.target.value)}
            placeholder={t('qr_tokens.mint_batch_placeholder')}
            className="input mt-0"
          />
        </label>
        <button
          type="submit"
          disabled={mint.isPending}
          className="btn btn-primary min-h-[40px] text-[14px] px-4 disabled:opacity-55"
        >
          <Plus size={14} />
          {mint.isPending ? t('qr_tokens.minting') : t('qr_tokens.mint_button')}
        </button>
      </div>
      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      {minted !== null && (
        <p className="text-[13px] text-sage row gap-1.5 items-center">
          <Check size={13} />
          {t('qr_tokens.minted_ok', { count: minted })}
        </p>
      )}
    </form>
  );
}

// ── Bind modal ──────────────────────────────────────────────────────

function BindModal({
  authToken,
  row,
  onClose,
  onBound,
}: {
  authToken: string | null;
  row: QRTokenRow;
  onClose: () => void;
  onBound: () => void;
}) {
  const { t } = useTranslation();
  const [restaurantId, setRestaurantId] = useState('');
  const [tableCode, setTableCode] = useState('T-01');
  const [error, setError] = useState<string | null>(null);

  const restaurantsQuery = useQuery({
    queryKey: ['bind-restaurants'],
    queryFn: () => api.get<RestaurantRow[]>('/restaurants', authToken),
    enabled: Boolean(authToken),
  });
  const restaurants = restaurantsQuery.data ?? [];

  const bind = useMutation({
    mutationFn: async () => {
      if (!restaurantId) throw new Error('pick a restaurant');
      if (!tableCode.trim()) throw new Error('enter a table code');
      return api.post<QRTokenRow>(
        `/admin/platform/qr-tokens/${row.token}/bind`,
        { restaurant_id: restaurantId, table_code: tableCode.trim() },
        authToken,
      );
    },
    onSuccess: onBound,
    onError: (e: ApiException) => setError(e.message ?? 'bind failed'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    bind.mutate();
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/25 flex items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-[440px] bg-s-paper border border-s-line rounded-lg shadow-pop overflow-hidden"
      >
        <div className="row spread items-start px-5 pt-4 pb-3 border-b border-s-line">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('qr_tokens.bind_eyebrow')}
            </div>
            <h2 className="display text-[20px] text-s-ink">
              {t('qr_tokens.bind_title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3.5">
          <div className="rounded-md border border-s-line bg-s-bg/40 px-3 py-2">
            <div className="text-[11.5px] text-s-muted dev uppercase tracking-wide">
              {t('qr_tokens.bind_token_label')}
            </div>
            <div className="font-mono text-[13px] text-s-ink">{row.token}</div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('qr_tokens.bind_restaurant_label')}
            </span>
            <select
              required
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
              className="input mt-0"
            >
              <option value="" disabled>
                {t('qr_tokens.bind_restaurant_placeholder')}
              </option>
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.slug})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('qr_tokens.bind_table_label')}
            </span>
            <input
              required
              type="text"
              maxLength={64}
              value={tableCode}
              onChange={(e) => setTableCode(e.target.value)}
              placeholder="T-01"
              className="input mt-0 font-mono max-w-[160px]"
            />
            <span className="text-[11.5px] text-s-muted">
              {t('qr_tokens.bind_table_hint')}
            </span>
          </label>
          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-s-line row gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-outline min-h-[38px] text-[13.5px] px-4"
          >
            {t('qr_tokens.bind_cancel')}
          </button>
          <button
            type="submit"
            disabled={bind.isPending}
            className="btn btn-primary min-h-[38px] text-[13.5px] px-4 disabled:opacity-55"
          >
            <LinkIcon size={13} />
            {bind.isPending
              ? t('qr_tokens.bind_saving')
              : t('qr_tokens.bind_submit')}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Retire confirm ──────────────────────────────────────────────────

function RetireModal({
  authToken,
  row,
  onClose,
  onRetired,
}: {
  authToken: string | null;
  row: QRTokenRow;
  onClose: () => void;
  onRetired: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  const retire = useMutation({
    mutationFn: () =>
      api.post<QRTokenRow>(
        `/admin/platform/qr-tokens/${row.token}/retire`,
        {},
        authToken,
      ),
    onSuccess: onRetired,
    onError: (e: ApiException) => setError(e.message ?? 'retire failed'),
  });

  return (
    <div className="fixed inset-0 z-40 bg-black/25 flex items-center justify-center p-4">
      <div className="w-full max-w-[420px] bg-s-paper border border-s-line rounded-lg shadow-pop overflow-hidden">
        <div className="row spread items-start px-5 pt-4 pb-3 border-b border-s-line">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('qr_tokens.retire_eyebrow')}
            </div>
            <h2 className="display text-[20px] text-s-ink">
              {t('qr_tokens.retire_title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-2">
          <p className="text-[13.5px] text-s-ink">
            {t('qr_tokens.retire_confirm', {
              token: row.token,
              restaurant: row.restaurant_name ?? '—',
              table: row.table_code ?? '—',
            })}
          </p>
          <p className="text-[12.5px] text-s-muted leading-snug">
            {t('qr_tokens.retire_blurb')}
          </p>
          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 mt-1">
              {error}
            </p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-s-line row gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-outline min-h-[38px] text-[13.5px] px-4"
          >
            {t('qr_tokens.retire_cancel')}
          </button>
          <button
            type="button"
            onClick={() => retire.mutate()}
            disabled={retire.isPending}
            className="btn min-h-[38px] text-[13.5px] px-4 bg-danger text-white hover:bg-danger/90 disabled:opacity-55"
          >
            <Trash2 size={13} />
            {retire.isPending
              ? t('qr_tokens.retire_running')
              : t('qr_tokens.retire_submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
