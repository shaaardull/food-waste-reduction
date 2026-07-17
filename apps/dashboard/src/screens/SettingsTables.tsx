import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Grid3x3,
  MoreVertical,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  Trash2,
  Users as UsersIcon,
  X as CloseIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useToasts } from '../lib/toasts';

/**
 * Settings → Tables — owner/manager-facing table registry.
 *
 * Backend contract (see apps/api/app/routers/restaurant_tables.py):
 *   GET    /restaurants/:id/tables?include_inactive=
 *   POST   /restaurants/:id/tables
 *   PATCH  /restaurants/:id/tables/:table_id
 *   DELETE /restaurants/:id/tables/:table_id           (soft)
 *   POST   /restaurants/:id/tables/:table_id/regenerate-qr
 *
 * Design notes:
 *   • Card list capped at ~720px width for a comfortable read on
 *     iPad-first, single-column layout. Mirrors the existing Settings
 *     screen's max width so the two feel like siblings.
 *   • Kebab menu instead of a wall of inline buttons — the row is
 *     dense already with code + seats + QR chip.
 *   • Reorder via ↑/↓ arrows rather than drag-and-drop. Two PATCH
 *     calls per swap, no new dependencies, no touch/mouse edge cases.
 *   • Recently removed collapses by default — most days it stays
 *     empty. When populated, one-tap Restore does a PATCH is_active=true.
 */

type TokenState = 'unassigned' | 'assigned' | 'retired';

interface TableRow {
  id: string;
  table_code: string;
  seat_count: number;
  is_active: boolean;
  display_order: number;
  notes: string | null;
  qr_token: { id: string; token: string; state: TokenState } | null;
}

export function SettingsTables() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId, activeRestaurant } = useAuthStore();
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const listKey = ['restaurant-tables', restaurantId, 'with-inactive'];
  const { data, isLoading, error } = useQuery<TableRow[]>({
    queryKey: listKey,
    queryFn: () =>
      api.get<TableRow[]>(
        `/restaurants/${restaurantId}/tables?include_inactive=true`,
        token,
      ),
    enabled: Boolean(token && restaurantId),
  });

  const active = useMemo(
    () => (data ?? []).filter((r) => r.is_active),
    [data],
  );
  const removed = useMemo(
    () => (data ?? []).filter((r) => !r.is_active),
    [data],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<TableRow | null>(null);
  const [regenFor, setRegenFor] = useState<TableRow | null>(null);
  const [removeFor, setRemoveFor] = useState<TableRow | null>(null);
  const [removedOpen, setRemovedOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: listKey });

  const swap = useMutation({
    mutationFn: async ({ a, b }: { a: TableRow; b: TableRow }) => {
      // Two independent PATCHes — we don't need a batch endpoint since
      // reorder is rare and both writes hit the same table via
      // display_order only.
      await api.patch(
        `/restaurants/${restaurantId}/tables/${a.id}`,
        { display_order: b.display_order },
        token,
      );
      await api.patch(
        `/restaurants/${restaurantId}/tables/${b.id}`,
        { display_order: a.display_order },
        token,
      );
    },
    onSuccess: () => void invalidate(),
  });

  const restore = useMutation({
    mutationFn: (row: TableRow) =>
      api.patch(
        `/restaurants/${restaurantId}/tables/${row.id}`,
        { is_active: true },
        token,
      ),
    onSuccess: () => {
      void invalidate();
      pushToast({
        tone: 'sage',
        title: t('settings.tables.toast_restored_title'),
        body: t('settings.tables.toast_restored_body'),
      });
    },
    onError: (err: ApiException) =>
      pushToast({
        tone: 'alert',
        title: t('settings.tables.err_generic'),
        body: err.message,
      }),
  });

  function openPrintFor(row: TableRow) {
    if (!row.qr_token) return;
    const params = new URLSearchParams();
    params.set('token', row.qr_token.token);
    if (activeRestaurant?.slug) params.set('restaurant', activeRestaurant.slug);
    window.open(`/-/platform/qr-print?${params.toString()}`, '_blank', 'noopener');
  }

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('summary.pick_restaurant')}</p>
    );
  }
  if (isLoading) {
    return <p className="text-s-muted text-sm">{t('settings.tables.loading')}</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
        {(error as Error).message}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-5 max-w-[720px]">
      <header className="row spread items-start gap-3">
        <div>
          <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
            <Grid3x3 size={12} />
            {t('settings.tables.eyebrow')}
          </div>
          <h1 className="display text-[28px] text-s-ink leading-tight">
            {t('settings.tables.title')}
          </h1>
          <p className="text-[13px] text-s-muted mt-1 max-w-[54ch]">
            {t('settings.tables.blurb')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="row gap-1.5 items-center bg-brand text-white font-semibold text-[13.5px] rounded-md px-3.5 py-2 hover:bg-brand-press transition shrink-0"
        >
          <Plus size={14} />
          {t('settings.tables.add_cta')}
        </button>
      </header>

      {active.length === 0 ? (
        <EmptyState onAdd={() => setAddOpen(true)} />
      ) : (
        <div className="flex flex-col gap-2.5">
          {active.map((row, i) => (
            <TableCard
              key={row.id}
              row={row}
              onMoveUp={
                i > 0
                  ? () => swap.mutate({ a: row, b: active[i - 1]! })
                  : undefined
              }
              onMoveDown={
                i < active.length - 1
                  ? () => swap.mutate({ a: row, b: active[i + 1]! })
                  : undefined
              }
              onEdit={() => setEditing(row)}
              onRegenerate={() => setRegenFor(row)}
              onPrint={row.qr_token ? () => openPrintFor(row) : undefined}
              onRemove={() => setRemoveFor(row)}
            />
          ))}
        </div>
      )}

      {removed.length > 0 && (
        <div className="border border-s-line rounded-lg bg-s-paper overflow-hidden">
          <button
            type="button"
            onClick={() => setRemovedOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-s-bg transition"
          >
            {removedOpen ? (
              <ChevronDown size={14} className="text-s-muted" />
            ) : (
              <ChevronRight size={14} className="text-s-muted" />
            )}
            <span className="text-[13px] font-semibold text-s-ink">
              {t('settings.tables.removed_heading', { count: removed.length })}
            </span>
          </button>
          {removedOpen && (
            <div className="flex flex-col gap-2 p-3 border-t border-s-line/60">
              {removed.map((row) => (
                <div
                  key={row.id}
                  className="row spread items-center gap-3 px-3 py-2 rounded-md bg-s-bg"
                >
                  <span className="font-mono font-bold text-[15px] text-s-muted">
                    {row.table_code}
                  </span>
                  <span className="text-[12px] text-s-muted">
                    {t('settings.tables.seats_short', { count: row.seat_count })}
                  </span>
                  <button
                    type="button"
                    onClick={() => restore.mutate(row)}
                    disabled={restore.isPending}
                    className="ml-auto row gap-1.5 items-center text-[12.5px] font-semibold text-brand hover:text-brand-press transition disabled:opacity-55"
                  >
                    <RefreshCw size={12} />
                    {t('settings.tables.restore')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {addOpen && (
        <TableFormModal
          mode="add"
          suggestedCode={suggestNextCode(active)}
          onClose={() => setAddOpen(false)}
          onSaved={(row) => {
            setAddOpen(false);
            void invalidate();
            pushToast({
              tone: 'sage',
              title: t('settings.tables.toast_added_title', {
                code: row.table_code,
              }),
              body: t('settings.tables.toast_added_body'),
              href: row.qr_token
                ? (() => {
                    const params = new URLSearchParams();
                    params.set('token', row.qr_token!.token);
                    if (activeRestaurant?.slug) {
                      params.set('restaurant', activeRestaurant.slug);
                    }
                    return `/-/platform/qr-print?${params.toString()}`;
                  })()
                : undefined,
            });
          }}
        />
      )}
      {editing && (
        <TableFormModal
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      )}
      {regenFor && (
        <RegenerateModal
          row={regenFor}
          onClose={() => setRegenFor(null)}
          onDone={() => {
            setRegenFor(null);
            void invalidate();
            pushToast({
              tone: 'saffron',
              title: t('settings.tables.toast_regen_title'),
              body: t('settings.tables.toast_regen_body'),
            });
          }}
        />
      )}
      {removeFor && (
        <RemoveModal
          row={removeFor}
          onClose={() => setRemoveFor(null)}
          onDone={() => {
            setRemoveFor(null);
            void invalidate();
          }}
        />
      )}
    </section>
  );
}

/**
 * Match the backend's `_next_sequential_code` logic on the client so
 * the "Add table" modal can pre-fill the field. The server still
 * treats an omitted code as authoritative — this is just a hint.
 */
function suggestNextCode(active: TableRow[]): string {
  let highest = 0;
  for (const r of active) {
    const m = /^T-(\d{2,4})$/.exec(r.table_code);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > highest) highest = n;
    }
  }
  return `T-${String(highest + 1).padStart(2, '0')}`;
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 py-14 border border-dashed border-s-line rounded-lg bg-s-paper text-center">
      <div className="w-14 h-14 rounded-lg bg-brand-wash flex items-center justify-center text-brand">
        <Grid3x3 size={22} />
      </div>
      <div>
        <div className="font-semibold text-[15px] text-s-ink">
          {t('settings.tables.empty_title')}
        </div>
        <p className="text-[13px] text-s-muted mt-1 max-w-[42ch]">
          {t('settings.tables.empty_blurb')}
        </p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="row gap-1.5 items-center bg-brand text-white font-semibold text-[14px] rounded-md px-4 py-2 hover:bg-brand-press transition"
      >
        <Plus size={14} />
        {t('settings.tables.empty_cta')}
      </button>
    </div>
  );
}

function TableCard({
  row,
  onMoveUp,
  onMoveDown,
  onEdit,
  onRegenerate,
  onPrint,
  onRemove,
}: {
  row: TableRow;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onPrint?: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const hasQr = Boolean(row.qr_token);

  return (
    <div className="row items-center gap-3 rounded-lg border border-s-line bg-s-paper px-4 py-3">
      <div className="flex flex-col gap-0.5 shrink-0">
        <button
          type="button"
          disabled={!onMoveUp}
          onClick={onMoveUp}
          aria-label={t('settings.tables.move_up')}
          className="w-6 h-5 rounded flex items-center justify-center text-s-muted hover:text-s-ink hover:bg-s-bg disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          <ArrowUp size={12} />
        </button>
        <button
          type="button"
          disabled={!onMoveDown}
          onClick={onMoveDown}
          aria-label={t('settings.tables.move_down')}
          className="w-6 h-5 rounded flex items-center justify-center text-s-muted hover:text-s-ink hover:bg-s-bg disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          <ArrowDown size={12} />
        </button>
      </div>

      <div className="font-mono font-bold text-[17px] text-s-ink w-[70px] shrink-0">
        {row.table_code}
      </div>

      <div className="flex flex-wrap gap-1.5 items-center min-w-0 flex-1">
        <span className="row gap-1 items-center text-[12px] text-s-muted bg-s-line/70 px-2 py-0.5 rounded-full">
          <UsersIcon size={11} />
          {row.seat_count}
        </span>
        <span
          className={clsx(
            'row gap-1 items-center text-[12px] px-2 py-0.5 rounded-full',
            hasQr
              ? 'bg-sage/15 text-sage-deep'
              : 'bg-s-line/50 text-s-muted',
          )}
        >
          <QrCode size={11} />
          {hasQr
            ? t('settings.tables.qr_bound')
            : t('settings.tables.qr_missing')}
        </span>
        {row.notes && (
          <span className="text-[12px] text-s-muted italic truncate max-w-[28ch]">
            {row.notes}
          </span>
        )}
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={t('settings.tables.row_actions')}
          className="w-9 h-9 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
        >
          <MoreVertical size={16} />
        </button>
        {menuOpen && (
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-30"
            />
            <div className="absolute right-0 top-full mt-1 z-40 min-w-[200px] rounded-md border border-s-line bg-s-paper shadow-pop py-1">
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
                label={t('settings.tables.action_edit')}
              />
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onRegenerate();
                }}
                icon={<RefreshCw size={13} />}
                label={t('settings.tables.action_regenerate')}
              />
              {onPrint && (
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    onPrint();
                  }}
                  icon={<Printer size={13} />}
                  label={t('settings.tables.action_print')}
                />
              )}
              <div className="my-1 border-t border-s-line/60" />
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onRemove();
                }}
                icon={<Trash2 size={13} />}
                label={t('settings.tables.action_remove')}
                tone="danger"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  onClick,
  label,
  icon,
  tone,
}: {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'w-full text-left px-3 py-1.5 text-[13px] row gap-2 items-center hover:bg-s-bg transition',
        tone === 'danger' ? 'text-danger' : 'text-s-ink',
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {label}
    </button>
  );
}

/* ─────────── Add / Edit modal ─────────── */

function TableFormModal({
  mode,
  initial,
  suggestedCode,
  onClose,
  onSaved,
}: {
  mode: 'add' | 'edit';
  initial?: TableRow;
  suggestedCode?: string;
  onClose: () => void;
  onSaved: (row: TableRow) => void;
}) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const [tableCode, setTableCode] = useState(
    initial?.table_code ?? suggestedCode ?? '',
  );
  const [seatCount, setSeatCount] = useState(initial?.seat_count ?? 4);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [autoQr, setAutoQr] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (): Promise<TableRow> => {
      if (mode === 'add') {
        return api.post<TableRow>(
          `/restaurants/${restaurantId}/tables`,
          {
            table_code: tableCode.trim() || null,
            seat_count: seatCount,
            auto_generate_qr: autoQr,
            notes: notes.trim() || null,
          },
          token,
        );
      }
      return api.patch<TableRow>(
        `/restaurants/${restaurantId}/tables/${initial!.id}`,
        {
          table_code: tableCode.trim(),
          seat_count: seatCount,
          notes: notes.trim() || null,
        },
        token,
      );
    },
    onSuccess: (row) => onSaved(row),
    onError: (e: ApiException) => setErr(e.message),
  });

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[480px] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-brand dev uppercase tracking-wide">
              {mode === 'add'
                ? t('settings.tables.modal_add_eyebrow')
                : t('settings.tables.modal_edit_eyebrow')}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {mode === 'add'
                ? t('settings.tables.modal_add_title')
                : t('settings.tables.modal_edit_title', {
                    code: initial?.table_code ?? '',
                  })}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.tables.close_modal')}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setErr(null);
            save.mutate();
          }}
          className="flex flex-col gap-4 p-5"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('settings.tables.field_code')}
            </span>
            <input
              type="text"
              value={tableCode}
              onChange={(e) => setTableCode(e.target.value.toUpperCase())}
              maxLength={64}
              placeholder="T-09"
              className="input mt-0 font-mono tracking-wide max-w-[220px]"
            />
            <span className="text-[11.5px] text-s-muted">
              {t('settings.tables.field_code_hint')}
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('settings.tables.field_seats')}
            </span>
            <input
              type="number"
              min={1}
              max={20}
              value={seatCount}
              onChange={(e) =>
                setSeatCount(Math.max(1, Math.min(20, parseInt(e.target.value || '4', 10))))
              }
              className="input mt-0 max-w-[120px]"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('settings.tables.field_notes')}
            </span>
            <input
              type="text"
              maxLength={200}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('settings.tables.field_notes_placeholder')}
              className="input mt-0"
            />
          </label>

          {mode === 'add' && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoQr}
                onChange={(e) => setAutoQr(e.target.checked)}
                className="mt-1 w-4 h-4 accent-brand"
              />
              <div className="flex-1">
                <div className="font-semibold text-[13.5px] text-s-ink">
                  {t('settings.tables.field_auto_qr')}
                </div>
                <p className="text-[12px] text-s-muted leading-snug mt-0.5">
                  {t('settings.tables.field_auto_qr_hint')}
                </p>
              </div>
            </label>
          )}

          {err && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {err}
            </p>
          )}

          <div className="row gap-2 justify-end pt-2 border-t border-s-line/60">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-md border border-s-line text-s-ink font-semibold text-[13.5px] hover:bg-s-bg transition"
            >
              {t('settings.tables.cancel')}
            </button>
            <button
              type="submit"
              disabled={save.isPending}
              className="h-10 px-5 rounded-md bg-brand text-white font-semibold text-[13.5px] hover:bg-brand-press transition disabled:opacity-60"
            >
              {save.isPending
                ? t('settings.tables.saving')
                : mode === 'add'
                  ? t('settings.tables.add_confirm')
                  : t('settings.tables.save_confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────── Regenerate confirm ─────────── */

function RegenerateModal({
  row,
  onClose,
  onDone,
}: {
  row: TableRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const [err, setErr] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () =>
      api.post<TableRow>(
        `/restaurants/${restaurantId}/tables/${row.id}/regenerate-qr`,
        undefined,
        token,
      ),
    onSuccess: () => onDone(),
    onError: (e: ApiException) => setErr(e.message),
  });
  return (
    <ConfirmModal
      eyebrow={t('settings.tables.regen_eyebrow')}
      title={t('settings.tables.regen_title', { code: row.table_code })}
      body={t('settings.tables.regen_body')}
      confirmLabel={
        mut.isPending
          ? t('settings.tables.working')
          : t('settings.tables.regen_confirm')
      }
      confirmTone="saffron"
      err={err}
      disabled={mut.isPending}
      onCancel={onClose}
      onConfirm={() => mut.mutate()}
    />
  );
}

/* ─────────── Remove confirm ─────────── */

function RemoveModal({
  row,
  onClose,
  onDone,
}: {
  row: TableRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const [err, setErr] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () =>
      api.del(`/restaurants/${restaurantId}/tables/${row.id}`, token),
    onSuccess: () => onDone(),
    onError: (e: ApiException) => setErr(e.message),
  });
  return (
    <ConfirmModal
      eyebrow={t('settings.tables.remove_eyebrow')}
      title={t('settings.tables.remove_title', { code: row.table_code })}
      body={t('settings.tables.remove_body')}
      confirmLabel={
        mut.isPending
          ? t('settings.tables.working')
          : t('settings.tables.remove_confirm')
      }
      confirmTone="danger"
      err={err}
      disabled={mut.isPending}
      onCancel={onClose}
      onConfirm={() => mut.mutate()}
    />
  );
}

/* ─────────── Confirm shell ─────────── */

function ConfirmModal({
  eyebrow,
  title,
  body,
  confirmLabel,
  confirmTone,
  err,
  disabled,
  onCancel,
  onConfirm,
}: {
  eyebrow: string;
  title: string;
  body: string;
  confirmLabel: string;
  confirmTone: 'danger' | 'saffron';
  err: string | null;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const toneClasses =
    confirmTone === 'danger'
      ? 'bg-danger text-white hover:bg-danger/90'
      : 'bg-saffron text-white hover:bg-saffron/90';
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[440px] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line">
          <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
            {eyebrow}
          </div>
          <h2 className="display text-[20px] text-s-ink leading-tight">
            {title}
          </h2>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <p className="text-[13.5px] text-s-muted leading-normal">{body}</p>
          {err && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {err}
            </p>
          )}
          <div className="row gap-2 justify-end pt-2 border-t border-s-line/60">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 px-4 rounded-md border border-s-line text-s-ink font-semibold text-[13.5px] hover:bg-s-bg transition"
            >
              {t('settings.tables.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={disabled}
              className={clsx(
                'h-10 px-5 rounded-md font-semibold text-[13.5px] transition disabled:opacity-60',
                toneClasses,
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
